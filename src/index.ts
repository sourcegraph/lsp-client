import {
    createMessageConnection,
    NotificationType,
    RequestHandler,
    RequestType,
    toSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import { differenceBy, identity } from 'lodash'
import * as path from 'path'
import { from, fromEvent, merge, noop, Subject, Subscription, Unsubscribable } from 'rxjs'
import { filter, map, mapTo, scan, startWith, take } from 'rxjs/operators'
import { DocumentSelector, ProgressReporter, Subscribable, WorkspaceRoot } from 'sourcegraph'
import * as uuid from 'uuid'
import {
    ClientCapabilities,
    Diagnostic,
    DidChangeWorkspaceFoldersNotification,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    DocumentSelector as LSPDocumentSelector,
    InitializeParams,
    InitializeRequest,
    InitializeResult,
    LogMessageNotification,
    MarkupKind,
    PublishDiagnosticsNotification,
    Registration,
    RegistrationRequest,
    ServerCapabilities,
    WorkspaceFolder,
} from 'vscode-languageserver-protocol'
import { features } from './features'
import { Logger, LSP_TO_LOG_LEVEL } from './logging'
import { convertDiagnosticToDecoration, toLSPWorkspaceFolder } from './lsp-conversion'
import { WindowProgressClientCapabilities, WindowProgressNotification } from './protocol.progress.proposed'

type SourcegraphAPI = typeof import('sourcegraph')

const registrationId = (staticOptions: any): string =>
    (staticOptions && typeof staticOptions.id === 'string' && staticOptions.id) || uuid.v1()

function staticRegistrationsFromCapabilities(
    capabilities: ServerCapabilities,
    defaultSelector: DocumentSelector
): Registration[] {
    const staticRegistrations: Registration[] = []
    for (const feature of Object.values(features)) {
        if (capabilities[feature.capabilityName]) {
            staticRegistrations.push({
                method: feature.requestType.method,
                id: registrationId(capabilities[feature.capabilityName]),
                registerOptions: feature.capabilityToRegisterOptions(
                    capabilities[feature.capabilityName],
                    defaultSelector as LSPDocumentSelector
                ),
            })
        }
    }
    return staticRegistrations
}

export interface LSPConnection extends Unsubscribable {
    closed: boolean
    closeEvent: Subscribable<void>
    sendRequest<P, R>(type: RequestType<P, R, any, any>, params: P): Promise<R>
    sendNotification<P>(type: NotificationType<P, any>, params: P): void
    observeNotification<P>(type: NotificationType<P, any>): Subscribable<P>
    setRequestHandler<P, R>(type: RequestType<P, R, any, any>, handler: RequestHandler<P, R, any>): void
}

export interface LSPClient extends Unsubscribable {
    /**
     * Ensures a connection with the given workspace root, passes it to the given function.
     * If the workspace is not currently open in Sourcegraph, the connection is closed again after the Promise returned by the function resolved.
     *
     * @param workspaceRoot The workspace folder root URI that will be ensured to be open before calling the function.
     * @param fn Callback that is called with the connection.
     */
    withConnection<R>(workspaceRoot: URL, fn: (connection: LSPConnection) => Promise<R>): Promise<R>
}

export const webSocketTransport = ({
    serverUrl,
    logger,
}: {
    serverUrl: string | URL
    logger: Logger
}) => async (): Promise<LSPConnection> => {
    const socket = new WebSocket(serverUrl.toString())
    const event = await merge(fromEvent<Event>(socket, 'open'), fromEvent<Event>(socket, 'error'))
        .pipe(take(1))
        .toPromise()
    if (event.type === 'error') {
        throw new Error(`The WebSocket to the TypeScript backend at ${serverUrl} could not not be opened`)
    }
    const rpcWebSocket = toSocket(socket)
    const connection = createMessageConnection(
        new WebSocketMessageReader(rpcWebSocket),
        new WebSocketMessageWriter(rpcWebSocket),
        logger
    )
    socket.addEventListener('close', event => {
        logger.warn('WebSocket connection to TypeScript backend closed', event)
        connection.dispose()
    })
    socket.addEventListener('error', event => {
        logger.error('WebSocket error', event)
    })
    const notifications = new Subject<{ method: string; params: any }>()
    connection.onNotification((method, params) => {
        notifications.next({ method, params })
    })
    connection.listen()
    return {
        get closed(): boolean {
            return socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING
        },
        closeEvent: fromEvent<Event>(socket, 'close').pipe(
            mapTo(undefined),
            take(1)
        ),
        sendRequest: async (type, params) => connection.sendRequest(type, params),
        sendNotification: async (type, params) => connection.sendNotification(type, params),
        setRequestHandler: (type, handler) => connection.onRequest(type, handler),
        observeNotification: type =>
            notifications.pipe(
                filter(({ method }) => method === type.method),
                map(({ params }) => params)
            ),
        unsubscribe: () => {
            socket.close()
            connection.dispose()
        },
    }
}

export interface RegisterOptions {
    progressSuffix?: string
    sourcegraph: SourcegraphAPI
    supportsWorkspaceFolders?: boolean
    clientToServerURI?: (uri: URL) => URL
    serverToClientURI?: (uri: URL) => URL
    afterInitialize?: (initializeResult: InitializeResult) => Promise<void> | void
    logger?: Logger
    transport: () => Promise<LSPConnection> | LSPConnection
    documentSelector: DocumentSelector
}
export async function register({
    sourcegraph,
    clientToServerURI = identity,
    serverToClientURI = identity,
    logger = console,
    progressSuffix = '',
    supportsWorkspaceFolders,
    afterInitialize = noop,
    transport: createConnection,
    documentSelector,
}: RegisterOptions): Promise<LSPClient> {
    const subscriptions = new Subscription()
    // tslint:disable-next-line:no-object-literal-type-assertion
    const clientCapabilities = {
        textDocument: {
            hover: {
                dynamicRegistration: true,
                contentFormat: [MarkupKind.Markdown],
            },
            definition: {
                dynamicRegistration: true,
            },
        },
        experimental: {
            progress: true,
        },
    } as ClientCapabilities & WindowProgressClientCapabilities

    function syncTextDocuments(connection: LSPConnection): void {
        for (const textDocument of sourcegraph.workspace.textDocuments) {
            const serverTextDocumentUri = clientToServerURI(new URL(textDocument.uri))
            if (!sourcegraph.workspace.roots.some(root => serverTextDocumentUri.href.startsWith(root.uri.toString()))) {
                continue
            }
            const didOpenParams: DidOpenTextDocumentParams = {
                textDocument: {
                    uri: serverTextDocumentUri.href,
                    languageId: textDocument.languageId,
                    text: textDocument.text,
                    version: 1,
                },
            }
            connection.sendNotification(DidOpenTextDocumentNotification.type, didOpenParams)
        }
    }

    const registrationSubscriptions = new Map<string, Unsubscribable>()
    /**
     * @param scopeRootUri A workspace folder root URI to scope the providers to. If `null`, the provider is registered for all workspace folders.
     */
    function registerCapabilities(
        connection: LSPConnection,
        scopeRootUri: URL | null,
        registrations: Registration[]
    ): void {
        for (const registration of registrations) {
            const feature = features[registration.method]
            if (feature) {
                registrationSubscriptions.set(
                    registration.id,
                    feature.register({
                        connection,
                        sourcegraph,
                        scopeRootUri,
                        serverToClientURI,
                        clientToServerURI,
                        registerOptions: registration.registerOptions,
                    })
                )
            }
        }
    }

    async function connect(): Promise<LSPConnection> {
        const subscriptions = new Subscription()
        const decorationType = sourcegraph.app.createDecorationType()
        const connection = await createConnection()
        logger.log(`WebSocket connection to TypeScript backend opened`)
        subscriptions.add(
            connection.observeNotification(LogMessageNotification.type).subscribe(({ type, message }) => {
                const method = LSP_TO_LOG_LEVEL[type]
                const args = [
                    new Date().toLocaleTimeString() + ' %cLanguage Server%c %s',
                    'background-color: blue; color: white',
                    '',
                    message,
                ]
                logger[method](...args)
            })
        )

        // Display diagnostics as decorations
        /** Diagnostic by Sourcegraph text document URI */
        const diagnosticsByUri = new Map<string, Diagnostic[]>()
        subscriptions.add(() => {
            // Clear all diagnostics held by this connection
            for (const appWindow of sourcegraph.app.windows) {
                for (const viewComponent of appWindow.visibleViewComponents) {
                    if (diagnosticsByUri.has(viewComponent.document.uri)) {
                        viewComponent.setDecorations(decorationType, [])
                    }
                }
            }
        })

        subscriptions.add(
            connection.observeNotification(PublishDiagnosticsNotification.type).subscribe(params => {
                const uri = new URL(params.uri)
                const sourcegraphTextDocumentUri = serverToClientURI(uri)
                diagnosticsByUri.set(sourcegraphTextDocumentUri.href, params.diagnostics)
                for (const appWindow of sourcegraph.app.windows) {
                    for (const viewComponent of appWindow.visibleViewComponents) {
                        if (viewComponent.document.uri === sourcegraphTextDocumentUri.href) {
                            viewComponent.setDecorations(
                                decorationType,
                                params.diagnostics.map(d => convertDiagnosticToDecoration(sourcegraph, d))
                            )
                        }
                    }
                }
            })
        )

        subscriptions.add(
            sourcegraph.workspace.openedTextDocuments.subscribe(() => {
                for (const appWindow of sourcegraph.app.windows) {
                    for (const viewComponent of appWindow.visibleViewComponents) {
                        const diagnostics = diagnosticsByUri.get(viewComponent.document.uri) || []
                        viewComponent.setDecorations(
                            decorationType,
                            diagnostics.map(d => convertDiagnosticToDecoration(sourcegraph, d))
                        )
                    }
                }
            })
        )

        // Show progress reports
        const progressReporters = new Map<string, Promise<ProgressReporter>>()
        subscriptions.add(() => {
            // Cleanup unfinished progress reports
            for (const reporterPromise of progressReporters.values()) {
                // tslint:disable-next-line:no-floating-promises
                reporterPromise.then(reporter => {
                    reporter.complete()
                })
            }
            progressReporters.clear()
        })
        subscriptions.add(
            connection
                .observeNotification(WindowProgressNotification.type)
                .subscribe(async ({ id, title, message, percentage, done }) => {
                    try {
                        if (!sourcegraph.app.activeWindow || !sourcegraph.app.activeWindow.showProgress) {
                            return
                        }
                        let reporterPromise = progressReporters.get(id)
                        if (!reporterPromise) {
                            if (title) {
                                title = title + progressSuffix
                            }
                            reporterPromise = sourcegraph.app.activeWindow.showProgress({ title })
                            progressReporters.set(id, reporterPromise)
                        }
                        const reporter = await reporterPromise
                        reporter.next({ percentage, message })
                        if (done) {
                            reporter.complete()
                            progressReporters.delete(id)
                        }
                    } catch (err) {
                        logger.error('Error handling progress notification', err)
                    }
                })
        )
        return connection
    }

    async function initializeConnection(
        connection: LSPConnection,
        rootUri: URL | null,
        initParams: InitializeParams
    ): Promise<void> {
        const initializeResult = await connection.sendRequest(InitializeRequest.type, initParams)
        // Tell language server about all currently open text documents under this root
        syncTextDocuments(connection)

        // Convert static capabilities to dynamic registrations
        const staticRegistrations = staticRegistrationsFromCapabilities(initializeResult.capabilities, documentSelector)

        // Listen for dynamic capabilities
        connection.setRequestHandler(RegistrationRequest.type, params => {
            registerCapabilities(connection, rootUri, params.registrations)
        })
        // Register static capabilities
        registerCapabilities(connection, rootUri, staticRegistrations)

        await afterInitialize(initializeResult)
    }

    let withConnection: <R>(workspaceFolder: URL, fn: (connection: LSPConnection) => Promise<R>) => Promise<R>

    if (supportsWorkspaceFolders) {
        const connection = await connect()
        subscriptions.add(connection)
        withConnection = async (workspaceFolder, fn) => {
            let tempWorkspaceFolder: WorkspaceFolder | undefined
            // If workspace folder is not known yet, add it
            if (!sourcegraph.workspace.roots.some(root => root.uri.toString() === workspaceFolder.href)) {
                tempWorkspaceFolder = { uri: workspaceFolder.href, name: path.posix.basename(workspaceFolder.pathname) }
                connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, {
                    event: {
                        added: [tempWorkspaceFolder],
                    },
                })
            }
            try {
                return await fn(connection)
            } finally {
                // If workspace folder was added, remove it
                if (tempWorkspaceFolder) {
                    connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, {
                        event: {
                            removed: [tempWorkspaceFolder],
                        },
                    })
                }
            }
        }
        await initializeConnection(connection, null, {
            processId: null,
            rootUri: null,
            capabilities: clientCapabilities,
            workspaceFolders: sourcegraph.workspace.roots.map(toLSPWorkspaceFolder),
        })

        // Forward root changes
        subscriptions.add(
            from(sourcegraph.workspace.rootChanges)
                .pipe(
                    startWith(null),
                    map(() => [...sourcegraph.workspace.roots]),
                    scan<WorkspaceRoot[], { before: WorkspaceRoot[]; after: WorkspaceRoot[] }>(({ before }, after) => ({
                        before,
                        after,
                    })),
                    map(({ before, after }) => ({
                        added: differenceBy(after, before, root => root.uri.toString()).map(toLSPWorkspaceFolder),
                        removed: differenceBy(before, after, root => root.uri.toString()).map(toLSPWorkspaceFolder),
                    }))
                )
                .subscribe(event => {
                    connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event })
                })
        )
    } else {
        // Supports only one workspace root
        const connectionsByRootUri = new Map<string, Promise<LSPConnection>>()
        withConnection = async (workspaceFolder, fn) => {
            let connection = await connectionsByRootUri.get(workspaceFolder.href)
            if (!connection) {
                connection = await connect()
                subscriptions.add(connection)
            }
            try {
                return await fn(connection)
            } finally {
                connection.unsubscribe()
            }
        }
        function addRoots(added: ReadonlyArray<WorkspaceRoot>): void {
            for (const root of added) {
                const connectionPromise = (async () => {
                    try {
                        const connection = await connect()
                        subscriptions.add(connection)
                        await initializeConnection(connection, new URL(root.uri.toString()), {
                            processId: null,
                            rootUri: root.uri.toString(),
                            capabilities: clientCapabilities,
                            workspaceFolders: null,
                        })
                        return connection
                    } catch (err) {
                        logger.error('Error creating connection', err)
                        connectionsByRootUri.delete(root.uri.toString())
                        throw err
                    }
                })()
                connectionsByRootUri.set(root.uri.toString(), connectionPromise)
            }
        }
        subscriptions.add(
            from(sourcegraph.workspace.rootChanges)
                .pipe(
                    startWith(null),
                    map(() => [...sourcegraph.workspace.roots]),
                    scan((before, after) => {
                        // Create new connections for added workspaces
                        const added = differenceBy(after, before, root => root.uri.toString())
                        addRoots(added)

                        // Close connections for removed workspaces
                        const removed = differenceBy(before, after, root => root.uri.toString())
                        // tslint:disable-next-line no-floating-promises
                        Promise.all(
                            removed.map(async root => {
                                try {
                                    const connection = await connectionsByRootUri.get(root.uri.toString())
                                    if (connection) {
                                        connection.unsubscribe()
                                    }
                                } catch (err) {
                                    logger.error('Error disposing connection', err)
                                }
                            })
                        )
                        return after
                    })
                )
                .subscribe()
        )
        addRoots(sourcegraph.workspace.roots)
        await Promise.all(connectionsByRootUri.values())
    }

    return {
        withConnection,
        unsubscribe: () => subscriptions.unsubscribe(),
    }
}

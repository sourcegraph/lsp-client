import {
    createMessageConnection,
    MessageConnection,
    RequestType,
    toSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import { differenceBy, identity } from 'lodash'
import * as path from 'path'
import { from, Subscription, Unsubscribable } from 'rxjs'
import { concatMap, map, pairwise, startWith } from 'rxjs/operators'
import { ProgressReporter } from 'sourcegraph'
import * as uuid from 'uuid'
import {
    ClientCapabilities,
    DefinitionRequest,
    Diagnostic,
    DidChangeWorkspaceFoldersNotification,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    DocumentFilter,
    DocumentSelector,
    HoverRequest,
    ImplementationRequest,
    InitializeParams,
    InitializeRequest,
    InitializeResult,
    Location,
    LogMessageNotification,
    MarkupKind,
    PublishDiagnosticsNotification,
    ReferencesRequest,
    Registration,
    RegistrationRequest,
    ServerCapabilities,
    StaticRegistrationOptions,
    TypeDefinitionRequest,
    WorkspaceFolder,
} from 'vscode-languageserver-protocol'
import { Logger, LSP_TO_LOG_LEVEL } from './logging'
import {
    convertDiagnosticToDecoration,
    convertHover,
    convertLocations,
    rewriteUris,
    toLSPWorkspaceFolder,
} from './lsp-conversion'
import { WindowProgressClientCapabilities, WindowProgressNotification } from './protocol.progress.proposed'

type RegistrationOptions<T extends RequestType<any, any, any, any>> = Exclude<T['_'], undefined>[3]

type SourcegraphAPI = typeof import('sourcegraph')

export interface ConnectionOptions {
    progressSuffix?: string
    serverUrl: URL | string
    sourcegraph: SourcegraphAPI
    supportsWorkspaceFolders?: boolean
    clientToServerURI?: (uri: URL) => URL
    serverToClientURI?: (uri: URL) => URL
    afterInitialize?: (initializeResult: InitializeResult) => Promise<void>
    logger?: Logger
}

const getStaticRegistrationId = (staticOptions: StaticRegistrationOptions | boolean): string =>
    (typeof staticOptions !== 'boolean' && staticOptions.id) || uuid.v1()

function staticRegistrationsFromCapabilities(capabilities: ServerCapabilities): Registration[] {
    const staticRegistrations: Registration[] = []
    if (capabilities.hoverProvider) {
        const registerOptions: RegistrationOptions<typeof HoverRequest.type> = { documentSelector: null }
        staticRegistrations.push({ method: HoverRequest.type.method, id: uuid.v1(), registerOptions })
    }
    if (capabilities.definitionProvider) {
        const registerOptions: RegistrationOptions<typeof DefinitionRequest.type> = { documentSelector: null }
        staticRegistrations.push({ method: DefinitionRequest.type.method, id: uuid.v1(), registerOptions })
    }
    if (capabilities.typeDefinitionProvider) {
        const registerOptions: RegistrationOptions<
            typeof ImplementationRequest.type
        > = (typeof capabilities.typeDefinitionProvider === 'object' && capabilities.typeDefinitionProvider) || {
            documentSelector: null,
        }
        staticRegistrations.push({
            method: ImplementationRequest.type.method,
            id: getStaticRegistrationId(capabilities.typeDefinitionProvider),
            registerOptions,
        })
    }
    if (capabilities.implementationProvider) {
        const registerOptions: RegistrationOptions<
            typeof ImplementationRequest.type
        > = (typeof capabilities.implementationProvider === 'object' && capabilities.implementationProvider) || {
            documentSelector: null,
        }
        staticRegistrations.push({
            method: ImplementationRequest.type.method,
            id: getStaticRegistrationId(capabilities.implementationProvider),
            registerOptions,
        })
    }
    if (capabilities.referencesProvider) {
        const registerOptions: RegistrationOptions<typeof ReferencesRequest.type> = { documentSelector: null }
        staticRegistrations.push({ method: ReferencesRequest.type.method, id: uuid.v1(), registerOptions })
    }
    return staticRegistrations
}

function scopeDocumentSelectorToRoot(documentSelector: DocumentSelector | null, rootUri: URL | null): DocumentSelector {
    if (!documentSelector || documentSelector.length === 0) {
        documentSelector = [{ pattern: '**' }]
    }
    if (!rootUri) {
        return documentSelector
    }
    return documentSelector
        .map((selector): DocumentFilter => (typeof selector === 'string' ? { language: selector } : selector))
        .map(selector => ({
            ...documentSelector,
            pattern: new URL(selector.pattern || '**', rootUri).href,
        }))
}

export interface LSPConnection {
    sendRequest<P, R>(type: RequestType<P, R, any, any>, params: P): PromiseLike<R>
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

export async function register(
    serverUrl: URL | string,
    sourcegraph: SourcegraphAPI,
    {
        clientToServerURI = identity,
        serverToClientURI = identity,
        logger = console,
        progressSuffix = '',
        supportsWorkspaceFolders,
    }: ConnectionOptions
): Promise<LSPClient> {
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
            implementation: {
                dynamicRegistration: true,
            },
            typeDefinition: {
                dynamicRegistration: true,
            },
        },
        experimental: {
            progress: true,
        },
    } as ClientCapabilities & WindowProgressClientCapabilities

    function syncTextDocuments(connection: MessageConnection): void {
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
        connection: MessageConnection,
        scopeRootUri: URL | null,
        registrations: Registration[]
    ): void {
        for (const registration of registrations) {
            let unsubscribable: Unsubscribable
            switch (registration.method) {
                case HoverRequest.type.method: {
                    const options = registration.registerOptions as RegistrationOptions<typeof HoverRequest.type>
                    unsubscribable = sourcegraph.languages.registerHoverProvider(
                        scopeDocumentSelectorToRoot(options.documentSelector, scopeRootUri),
                        {
                            provideHover: async (textDocument, position) => {
                                const result = await connection.sendRequest(HoverRequest.type, {
                                    textDocument: {
                                        uri: clientToServerURI(new URL(textDocument.uri)).href,
                                    },
                                    position,
                                })
                                rewriteUris(result, serverToClientURI)
                                return convertHover(result)
                            },
                        }
                    )
                    break
                }
                case DefinitionRequest.type.method: {
                    const options = registration.registerOptions as RegistrationOptions<typeof DefinitionRequest.type>
                    unsubscribable = sourcegraph.languages.registerDefinitionProvider(options.documentSelector || [], {
                        provideDefinition: async (textDocument, position) => {
                            const result = await connection.sendRequest(DefinitionRequest.type, {
                                textDocument: {
                                    uri: clientToServerURI(new URL(textDocument.uri)).href,
                                },
                                position,
                            })
                            rewriteUris(result, serverToClientURI)
                            return convertLocations(result as Location[] | Location | null)
                        },
                    })
                    break
                }
                case ReferencesRequest.type.method: {
                    const options = registration.registerOptions as RegistrationOptions<typeof ReferencesRequest.type>
                    unsubscribable = sourcegraph.languages.registerReferenceProvider(options.documentSelector || [], {
                        provideReferences: async (textDocument, position, context) => {
                            const result = await connection.sendRequest(ReferencesRequest.type, {
                                textDocument: {
                                    uri: clientToServerURI(new URL(textDocument.uri)).href,
                                },
                                position,
                                context,
                            })
                            rewriteUris(result, serverToClientURI)
                            return convertLocations(result as Location[] | Location | null)
                        },
                    })
                    break
                }
                case TypeDefinitionRequest.type.method: {
                    const options = registration.registerOptions as RegistrationOptions<
                        typeof TypeDefinitionRequest.type
                    >
                    unsubscribable = sourcegraph.languages.registerTypeDefinitionProvider(
                        options.documentSelector || [],
                        {
                            provideTypeDefinition: async (textDocument, position) => {
                                const result = await connection.sendRequest(TypeDefinitionRequest.type, {
                                    textDocument: {
                                        uri: clientToServerURI(new URL(textDocument.uri)).href,
                                    },
                                    position,
                                })
                                rewriteUris(result, serverToClientURI)
                                return convertLocations(result as Location[] | Location | null)
                            },
                        }
                    )
                    break
                }
                case ImplementationRequest.type.method: {
                    const options = registration.registerOptions as RegistrationOptions<
                        typeof ImplementationRequest.type
                    >
                    unsubscribable = sourcegraph.languages.registerImplementationProvider(
                        options.documentSelector || [],
                        {
                            provideImplementation: async (textDocument, position) => {
                                const result = await connection.sendRequest(ImplementationRequest.type, {
                                    textDocument: {
                                        uri: clientToServerURI(new URL(textDocument.uri)).href,
                                    },
                                    position,
                                })
                                rewriteUris(result, serverToClientURI)
                                return convertLocations(result as Location[] | Location | null)
                            },
                        }
                    )
                    break
                }
                default:
                    return
            }
            registrationSubscriptions.set(registration.id, unsubscribable)
        }
    }

    async function connect(): Promise<MessageConnection> {
        const subscriptions = new Subscription()
        const socket = new WebSocket(serverUrl.toString())
        const decorationType = sourcegraph.app.createDecorationType()
        subscriptions.add(() => socket.close())
        socket.addEventListener('close', event => {
            logger.warn('WebSocket connection to TypeScript backend closed', event)
            subscriptions.unsubscribe()
        })
        socket.addEventListener('error', event => {
            logger.error('WebSocket error', event)
        })
        const rpcWebSocket = toSocket(socket)
        const connection = createMessageConnection(
            new WebSocketMessageReader(rpcWebSocket),
            new WebSocketMessageWriter(rpcWebSocket),
            logger
        )
        connection.onDispose(() => subscriptions.unsubscribe())
        connection.onNotification(LogMessageNotification.type, ({ type, message }) => {
            // Blue background for the "TypeScript server" prefix
            const method = LSP_TO_LOG_LEVEL[type]
            const args = [
                new Date().toLocaleTimeString() + ' %cTypeScript backend%c %s',
                'background-color: blue; color: white',
                '',
                message,
            ]
            logger[method](...args)
        })

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

        connection.onNotification(PublishDiagnosticsNotification.type, params => {
            const uri = new URL(params.uri)
            const sourcegraphTextDocumentUri = serverToClientURI(uri)
            diagnosticsByUri.set(sourcegraphTextDocumentUri.href, params.diagnostics)
            for (const appWindow of sourcegraph.app.windows) {
                for (const viewComponent of appWindow.visibleViewComponents) {
                    if (viewComponent.document.uri === sourcegraphTextDocumentUri.href) {
                        viewComponent.setDecorations(
                            decorationType,
                            params.diagnostics.map(convertDiagnosticToDecoration)
                        )
                    }
                }
            }
        })

        subscriptions.add(
            sourcegraph.workspace.onDidOpenTextDocument.subscribe(() => {
                for (const appWindow of sourcegraph.app.windows) {
                    for (const viewComponent of appWindow.visibleViewComponents) {
                        const diagnostics = diagnosticsByUri.get(viewComponent.document.uri) || []
                        viewComponent.setDecorations(decorationType, diagnostics.map(convertDiagnosticToDecoration))
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
        connection.onNotification(WindowProgressNotification.type, async ({ id, title, message, percentage, done }) => {
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
        connection.listen()
        const event = await new Promise<Event>(resolve => {
            socket.addEventListener('open', resolve, { once: true })
            socket.addEventListener('error', resolve, { once: true })
        })
        if (event.type === 'error') {
            throw new Error(`The WebSocket to the TypeScript backend at ${serverUrl} could not not be opened`)
        }
        logger.log(`WebSocket connection to TypeScript backend at ${serverUrl} opened`)
        return connection
    }

    async function initializeConnection(
        connection: MessageConnection,
        rootUri: URL | null,
        initParams: InitializeParams
    ): Promise<void> {
        const initializeResult = await connection.sendRequest(InitializeRequest.type, initParams)
        // Tell language server about all currently open text documents under this root
        syncTextDocuments(connection)

        // Convert static capabilities to dynamic registrations
        const staticRegistrations = staticRegistrationsFromCapabilities(initializeResult.capabilities)

        // Listen for dynamic capabilities
        connection.onRequest(RegistrationRequest.type, params => {
            registerCapabilities(connection, rootUri, params.registrations)
        })
        // Register static capabilities
        registerCapabilities(connection, rootUri, staticRegistrations)
    }

    let withConnection: <R>(workspaceFolder: URL, fn: (connection: LSPConnection) => Promise<R>) => Promise<R>

    if (supportsWorkspaceFolders) {
        const connection = await connect()
        subscriptions.add(() => connection.dispose())
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
            from(sourcegraph.workspace.onDidChangeRoots)
                .pipe(
                    startWith(null),
                    map(() => sourcegraph.workspace.roots),
                    pairwise(),
                    map(([before, after]) => ({
                        added: differenceBy(after, before, root => root.uri.toString()).map(toLSPWorkspaceFolder),
                        removed: differenceBy(before, after, root => root.uri.toString()).map(toLSPWorkspaceFolder),
                    }))
                )
                .subscribe(event => {
                    connection.sendNotification(DidChangeWorkspaceFoldersNotification.type, { event })
                })
        )
    } else {
        const connectionsByRootUri = new Map<string, Promise<MessageConnection>>()
        withConnection = async (workspaceFolder, fn) => {
            let connection = await connectionsByRootUri.get(workspaceFolder.href)
            if (!connection) {
                connection = await connect()
                subscriptions.add(() => connection!.dispose())
            }
            try {
                return await fn(connection)
            } finally {
                connection.dispose()
            }
        }
        subscriptions.add(
            from(sourcegraph.workspace.onDidChangeRoots)
                .pipe(
                    startWith(null),
                    map(() => sourcegraph.workspace.roots),
                    pairwise(),
                    concatMap(([before, after]) => {
                        // Create new connections for added workspaces
                        const added = differenceBy(after, before, root => root.uri.toString())
                        for (const root of added) {
                            const connectionPromise = (async () => {
                                try {
                                    const connection = await connect()
                                    subscriptions.add(() => connection.dispose())
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
                            connectionsByRootUri.set(root.toString(), connectionPromise)
                        }

                        // Close connections for removed workspaces
                        const removed = differenceBy(before, after, root => root.uri.toString())
                        Promise.all(
                            removed.map(async root => {
                                try {
                                    const connection = await connectionsByRootUri.get(root.uri.toString())
                                    if (connection) {
                                        connection.dispose()
                                    }
                                } catch (err) {
                                    logger.error('Error disposing connection', err)
                                }
                            })
                        )
                        return []
                    })
                )
                .subscribe()
        )
    }

    return {
        withConnection,
        unsubscribe: () => subscriptions.unsubscribe(),
    }
}

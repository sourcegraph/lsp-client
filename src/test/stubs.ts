import { uniqueId } from 'lodash'
import { Observable, Subject, Subscription } from 'rxjs'
import * as sinon from 'sinon'
import * as sourcegraph from 'sourcegraph'
import { MarkupKind } from 'vscode-languageserver-types'

const URI = URL
type URI = URL
class Position {
    constructor(public line: number, public character: number) {}
}
class Range {
    constructor(public start: Position, public end: Position) {}
}
class Location {
    constructor(public uri: URI, public range: Range) {}
}
class Selection {
    constructor(public anchor: Position, public active: Position) {}
}

/**
 * Creates an object that (mostly) implements the Sourcegraph API,
 * with all methods being Sinon spys and all Subscribables being Subjects.
 */
export const createMockSourcegraphAPI = () => {
    const rootChanges = new Subject<void>()
    // const shims: typeof import('sourcegraph') = {
    const openedTextDocuments = new Subject<sourcegraph.TextDocument>()
    return {
        internal: {
            sourcegraphURL: 'https://sourcegraph.test',
        },
        URI,
        Position,
        Range,
        Location,
        Selection,
        MarkupKind,
        workspace: {
            onDidOpenTextDocument: openedTextDocuments,
            openedTextDocuments,
            textDocuments: [] as sourcegraph.TextDocument[],
            onDidChangeRoots: rootChanges,
            rootChanges,
            roots: [] as sourcegraph.WorkspaceRoot[],
        },
        languages: {
            registerHoverProvider: sinon.spy(
                (
                    selector: sourcegraph.DocumentSelector,
                    provider: {
                        provideHover: (
                            textDocument: sourcegraph.TextDocument,
                            position: Position
                        ) => Promise<sourcegraph.Hover | null>
                    }
                ) => new Subscription()
            ),
            registerDefinitionProvider: sinon.spy(
                (
                    selector: sourcegraph.DocumentSelector,
                    provider: {
                        provideDefinition: (
                            textDocument: sourcegraph.TextDocument,
                            position: Position
                        ) => Promise<sourcegraph.Definition>
                    }
                ) => new Subscription()
            ),
            registerLocationProvider: sinon.spy(),
            registerReferenceProvider: sinon.spy(),
            registerTypeDefinitionProvider: sinon.spy(),
            registerImplementationProvider: sinon.spy(),
        },
        app: {
            createDecorationType: () => ({ key: uniqueId('decorationType') }),
        },
        configuration: {},
        search: {},
        commands: {},
    }
}

export const stubTransport = (server: Record<string, (params: any) => any>) =>
    sinon.spy(() => {
        const closeEvent = new Subject<void>()
        let closed = false
        return {
            sendNotification: sinon.spy(),
            sendRequest: sinon.spy(async ({ method }, params) => {
                if (method in server) {
                    return (server as any)[method](params)
                }
                throw new Error('Unhandled method ' + method)
            }),
            observeNotification: () => new Observable<never>(),
            setRequestHandler: sinon.spy(),
            closeEvent,
            unsubscribe: sinon.spy(() => {
                closeEvent.next()
                closeEvent.complete()
                closed = true
            }),
            get closed(): boolean {
                return closed
            },
        }
    })

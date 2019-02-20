import * as assert from 'assert'
import mock from 'mock-require'
import * as sinon from 'sinon'
import {
    Hover,
    InitializeParams,
    InitializeResult,
    MarkupKind,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { createMockSourcegraphAPI, stubTransport } from './stubs'

const sourcegraph = createMockSourcegraphAPI()
// For modules importing Range/Location/Position/URI/etc
mock('sourcegraph', sourcegraph)

import { register } from '..'
import { NoopLogger } from '../logging'

const logger = new NoopLogger()

describe('register()', () => {
    it('should initialize one connection with each workspace folder if the server is multi-root capable', async () => {
        const sourcegraph = createMockSourcegraphAPI()
        sourcegraph.workspace.roots = [{ uri: 'git://repo1?rev' }, { uri: 'git://repo2?rev' }]
        const server = {
            initialize: sinon.spy((params: InitializeParams): InitializeResult => ({ capabilities: {} })),
        }
        const createConnection = stubTransport(server)
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            supportsWorkspaceFolders: true,
            documentSelector: [{ language: 'foo' }],
            logger,
        })
        sinon.assert.calledOnce(createConnection)
        sinon.assert.calledOnce(server.initialize)
        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                rootUri: null,
                workspaceFolders: [{ name: '', uri: 'git://repo1?rev' }, { name: '', uri: 'git://repo2?rev' }],
            })
        )
    })
    it('should initialize one connection for each workspace folder if the server is not multi-root capable', async () => {
        const sourcegraph = createMockSourcegraphAPI()
        sourcegraph.workspace.roots = [{ uri: 'git://repo1?rev' }, { uri: 'git://repo2?rev' }]
        const server = {
            initialize: sinon.spy((params: InitializeParams): InitializeResult => ({ capabilities: {} })),
        }
        const createConnection = stubTransport(server)
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            supportsWorkspaceFolders: false,
            documentSelector: [{ language: 'foo' }],
            logger,
        })
        sinon.assert.calledTwice(createConnection)
        sinon.assert.calledTwice(server.initialize)
        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                rootUri: 'git://repo1?rev',
                workspaceFolders: null,
            })
        )
        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                rootUri: 'git://repo2?rev',
                workspaceFolders: null,
            })
        )
    })
    it('should close a connection when a workspace folder is closed', async () => {
        const sourcegraph = createMockSourcegraphAPI()
        sourcegraph.workspace.roots = [{ uri: 'git://repo1?rev' }, { uri: 'git://repo2?rev' }]
        const server = {
            initialize: sinon.spy((params: InitializeParams): InitializeResult => ({ capabilities: {} })),
        }
        const createConnection = stubTransport(server)
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            supportsWorkspaceFolders: false,
            documentSelector: [{ language: 'foo' }],
            logger,
        })
        const unsubscribed = createConnection.returnValues[0].closeEvent.toPromise()
        sourcegraph.workspace.roots.shift()
        sourcegraph.workspace.rootChanges.next()
        await unsubscribed
        sinon.assert.calledOnce(createConnection.returnValues[0].unsubscribe)
    })
    it('should register a hover provider if the server reports the hover capability', async () => {
        const repoRoot = 'https://sourcegraph.test/repo@rev/-/raw/'
        const server = {
            initialize: sinon.spy(
                async (params: InitializeParams): Promise<InitializeResult> => ({
                    capabilities: {
                        hoverProvider: true,
                    },
                })
            ),
            'textDocument/hover': sinon.spy(
                async (params: TextDocumentPositionParams): Promise<Hover> => ({
                    contents: { kind: MarkupKind.Markdown, value: 'Hello World' },
                })
            ),
        }
        const createConnection = stubTransport(server)

        sourcegraph.workspace.textDocuments = [
            {
                uri: repoRoot + '#foo.ts',
                languageId: 'typescript',
                text: 'console.log("Hello world")',
            },
        ]
        sourcegraph.workspace.roots = [{ uri: repoRoot }]

        const documentSelector = [{ language: 'typescript' }]
        await register({
            sourcegraph: sourcegraph as any,
            transport: createConnection,
            documentSelector,
            logger,
        })

        sinon.assert.calledWith(
            server.initialize,
            sinon.match({
                capabilities: {
                    textDocument: {
                        hover: {
                            contentFormat: ['markdown'],
                            dynamicRegistration: true,
                        },
                    },
                },
            })
        )

        // Assert hover provider was registered
        sinon.assert.calledOnce(sourcegraph.languages.registerHoverProvider)

        const [selector, hoverProvider] = sourcegraph.languages.registerHoverProvider.args[0]
        assert.deepStrictEqual(selector, [
            {
                language: 'typescript',
                // If the server is not multi-root capable and
                // we're in multi-connection mode, the document
                // selector should be scoped to the root URI
                // of the connection that registered the provider
                pattern: 'https://sourcegraph.test/repo@rev/-/raw/**',
            },
        ])
        const result = await hoverProvider.provideHover(
            sourcegraph.workspace.textDocuments[0],
            new sourcegraph.Position(0, 2)
        )
        sinon.assert.calledOnce(server['textDocument/hover'])
        sinon.assert.calledWith(server['textDocument/hover'], {
            textDocument: { uri: sourcegraph.workspace.textDocuments[0].uri },
            position: { line: 0, character: 2 },
        })
        assert.deepStrictEqual(result, {
            range: undefined,
            contents: { kind: MarkupKind.Markdown, value: 'Hello World' },
        })
    })
})

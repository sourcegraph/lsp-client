import { HoverRequest } from 'vscode-languageserver-protocol'
import { convertHover, rewriteUris } from '../lsp-conversion'
import { Feature, scopeDocumentSelectorToRoot } from './feature'

export const hoverFeature: Feature<typeof HoverRequest.type, 'hoverProvider'> = {
    capabilityName: 'hoverProvider',
    capabilityToRegisterOptions: (capability, documentSelector) => ({ documentSelector }),
    requestType: HoverRequest.type,
    register: ({ sourcegraph, connection, scopeRootUri, clientToServerURI, serverToClientURI, registerOptions }) =>
        sourcegraph.languages.registerHoverProvider(
            scopeDocumentSelectorToRoot(registerOptions.documentSelector, scopeRootUri),
            {
                provideHover: async (textDocument, position) => {
                    const result = await connection.sendRequest(HoverRequest.type, {
                        textDocument: {
                            uri: clientToServerURI(new URL(textDocument.uri)).href,
                        },
                        position: {
                            line: position.line,
                            character: position.character,
                        },
                    })
                    rewriteUris(result, serverToClientURI)
                    return convertHover(sourcegraph, result)
                },
            }
        ),
}

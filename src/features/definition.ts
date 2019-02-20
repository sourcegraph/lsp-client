import { DefinitionRequest, Location } from 'vscode-languageserver-protocol'
import { convertLocations, rewriteUris } from '../lsp-conversion'
import { Feature, scopeDocumentSelectorToRoot } from './feature'

export const definitionFeature: Feature<typeof DefinitionRequest.type, 'definitionProvider'> = {
    requestType: DefinitionRequest.type,
    capabilityName: 'definitionProvider',
    capabilityToRegisterOptions: (capability, defaultSelector) => ({ documentSelector: defaultSelector }),
    register: ({ sourcegraph, connection, scopeRootUri, clientToServerURI, serverToClientURI, registerOptions }) =>
        sourcegraph.languages.registerDefinitionProvider(
            scopeDocumentSelectorToRoot(registerOptions.documentSelector, scopeRootUri),
            {
                provideDefinition: async (textDocument, position) => {
                    const result = await connection.sendRequest(DefinitionRequest.type, {
                        textDocument: {
                            uri: clientToServerURI(new URL(textDocument.uri)).href,
                        },
                        position: {
                            line: position.line,
                            character: position.character,
                        },
                    })
                    rewriteUris(result, serverToClientURI)
                    return convertLocations(sourcegraph, result as Location | Location[] | null)
                },
            }
        ),
}

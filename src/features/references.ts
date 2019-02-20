import { ReferencesRequest } from 'vscode-languageserver-protocol'
import { convertLocations, rewriteUris } from '../lsp-conversion'
import { Feature, scopeDocumentSelectorToRoot } from './feature'

export const referencesFeature: Feature<typeof ReferencesRequest.type, 'referencesProvider'> = {
    requestType: ReferencesRequest.type,
    capabilityName: 'referencesProvider',
    capabilityToRegisterOptions: capability => ({ documentSelector: null }),
    register: ({ sourcegraph, connection, scopeRootUri, clientToServerURI, serverToClientURI, registerOptions }) =>
        sourcegraph.languages.registerReferenceProvider(
            scopeDocumentSelectorToRoot(registerOptions.documentSelector, scopeRootUri),
            {
                provideReferences: async (textDocument, position, context) => {
                    const result = await connection.sendRequest(ReferencesRequest.type, {
                        textDocument: {
                            uri: clientToServerURI(new URL(textDocument.uri)).href,
                        },
                        position,
                        context,
                    })
                    rewriteUris(result, serverToClientURI)
                    return convertLocations(sourcegraph, result)
                },
            }
        ),
}

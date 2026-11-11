import { createHandlerContext, type HandlerDeps } from './context.js'
import { register as registerApp } from './handlers/app.js'
import { register as registerProject } from './handlers/project.js'
import { register as registerDocuments } from './handlers/documents.js'
import { register as registerSearch } from './handlers/search.js'
import { register as registerRecords } from './handlers/records.js'
import { register as registerReview } from './handlers/review.js'
import { register as registerResearch } from './handlers/research.js'
import { register as registerAi } from './handlers/ai.js'
import { register as registerConnections } from './handlers/connections.js'
import { register as registerLayout } from './handlers/layout.js'

export { SessionRegistry, type HandlerDeps } from './context.js'

export function registerHandlers(deps: HandlerDeps): void {
  const context = createHandlerContext(deps)
  registerApp(context)
  registerProject(context)
  registerDocuments(context)
  registerSearch(context)
  registerRecords(context)
  registerReview(context)
  registerResearch(context)
  registerAi(context)
  registerConnections(context)
  registerLayout(context)
}

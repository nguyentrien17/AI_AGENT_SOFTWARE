import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Shell } from './pages/Shell';
import { AiPage } from './pages/Ai';
import { AgentsPage } from './pages/Agents';
import { CostsPage } from './pages/Costs';
import { ProjectPage } from './pages/Project';
import { ProjectsPage } from './pages/Projects';
import { TaskPage } from './pages/Task';

const rootRoute = createRootRoute({ component: Shell });
const projects = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ProjectsPage });
const project = createRoute({ getParentRoute: () => rootRoute, path: '/projects/$projectId', component: ProjectPage });
const task = createRoute({ getParentRoute: () => rootRoute, path: '/tasks/$taskId', component: TaskPage });
const ai = createRoute({ getParentRoute: () => rootRoute, path: '/ai', component: AiPage });
const agents = createRoute({ getParentRoute: () => rootRoute, path: '/agents', component: AgentsPage });
const costs = createRoute({ getParentRoute: () => rootRoute, path: '/costs', component: CostsPage });

export const router = createRouter({ routeTree: rootRoute.addChildren([projects, project, task, ai, agents, costs]) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

import { and, eq, isNull, ne } from "drizzle-orm";
import { projects, settings } from "../../../../shared/db/schema";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { projectStopTargets } from "../../../../shared/project/stop-targets";
import type { ProjectRepository } from "../domain/project-settings";

export function createProjectRepository(database: () => OpenedDatabase): ProjectRepository {
  return {
    find: (id) => database().db.select().from(projects).where(eq(projects.id, id)).get(),
    findPath: (path) => database().db.select().from(projects).where(eq(projects.path, path)).get(),
    nameTaken: (name, exceptId) =>
      database()
        .db.select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.name, name),
            isNull(projects.removedAt),
            exceptId === undefined ? undefined : ne(projects.id, exceptId),
          ),
        )
        .get() !== undefined,
    create: (project) => {
      database().db.insert(projects).values(project).run();
    },
    update: (id, patch) => {
      database().db.update(projects).set(patch).where(eq(projects.id, id)).run();
    },
    settings({ removedAt: _removedAt, ...project }) {
      const { db, sqlite } = database();
      return {
        ...project,
        globalFlowPaused:
          db
            .select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, "flow_paused"))
            .get()?.value === true,
        stopTargetCount: projectStopTargets(sqlite, project.id).length,
      };
    },
  };
}

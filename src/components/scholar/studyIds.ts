// What the full-window study area opens, by the prefix of its id (useScholar's `study`). Each kind has its own prefix,
// and ids are routed here and only here, so two kinds can't share one: Kea Hub practice was "hub:<set id>" while the
// local Study page was "hub:<scope>", and every local Study button opened Kea Hub practice instead.
//   page:     the local Study page for a scope (StudyHub.tsx)         "hub:<scope JSON, URI-encoded>"
//   hubSet:   a Kea Hub class's practice set (HubClasses.tsx)         "hubset:<set id>"
//   readings: a class's readings (ScholarScreen.tsx)                  "readings:<course id>"
//   player:   everything else goes to StudyPlayer (a set id, "stream:", "saved:", "review:", "edit:")
export const STUDY_PAGE = 'hub:';
export const HUB_SET = 'hubset:';
export const READINGS = 'readings:';

export type StudyRoute = { kind: 'page'; scope: string } | { kind: 'hubSet'; setId: string } | { kind: 'readings'; courseId: string } | { kind: 'player'; id: string };

export function studyRoute(id: string): StudyRoute {
  if (id.startsWith(HUB_SET)) return { kind: 'hubSet', setId: id.slice(HUB_SET.length) };
  if (id.startsWith(STUDY_PAGE)) return { kind: 'page', scope: id.slice(STUDY_PAGE.length) };
  if (id.startsWith(READINGS)) return { kind: 'readings', courseId: id.slice(READINGS.length) };
  return { kind: 'player', id };
}
export const hubSetId = (setId: string) => `${HUB_SET}${setId}`;
export const studyPageId = (scope: object) => `${STUDY_PAGE}${encodeURIComponent(JSON.stringify(scope))}`;

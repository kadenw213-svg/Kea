// Stands in for mobile/src/kea.ts when the phone's account code is bundled for Node: the native side is the test's
// fake (globalThis.__keaMock, set before the bundle is loaded).
export const Kea = globalThis.__keaMock;

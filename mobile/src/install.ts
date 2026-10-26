// Imported first (main.tsx): the shared screens from Kea on the PC read window.api when they load.
import { installDesktopApi } from './desktopApi';
import { Kea } from './kea';
import { getLook, onThemeChange, setLook } from './theme';

installDesktopApi();
// The settings the shared screens keep (Listen's options, the reading on a miss, dark pages): saved on the phone, read
// back here (Kea on the PC's own startup would also restyle the app, which the phone does itself).
// (Imported only now: the settings module reads window.api as it loads, so it must come after the line above.)
import('../../src/lib/settings').then(({ useSettings }) =>
  (window as any).api.settings.get().then((stored: Record<string, any>) => {
    // The theme is the phone's own (Settings → Appearance, or the reader's page colours); the shared screens read it
    // from their settings, and a reader toggle in them (dark pages) turns the phone's theme too.
    useSettings.setState((s) => ({ values: { ...s.values, ...stored, 'appearance.theme': getLook().theme, 'pdf.darkPages': 'match' }, loaded: true }));
    onThemeChange((l) => useSettings.getState().values['appearance.theme'] !== l.theme && useSettings.setState((s) => ({ values: { ...s.values, 'appearance.theme': l.theme } })));
    useSettings.subscribe((s, prev) => {
      const t = s.values['appearance.theme'];
      if (t && t !== prev.values['appearance.theme'] && t !== getLook().theme) setLook({ theme: t });
    });
  })
);
// Read aloud (a flashcard's side) with the phone's voices, in the voice and speed chosen for books.
(window as any).keaSpeak = (text: string) => {
  const l = getLook();
  Kea.say({ text, voice: l.voice || undefined, rate: l.rate }).catch(() => {});
};
// Listen (a deck read aloud) through Kea's reader: it keeps going with the screen off, with its notification.
(window as any).keaReadQueue = {
  start: (items: { id: string; text: string; pause: number }[], o: { title: string; rate: number; loop: boolean }) =>
    Kea.readAloud({ items, title: o.title, voice: getLook().voice || undefined, rate: o.rate, loop: o.loop }).catch(() => {}),
  control: (action: 'pause' | 'resume' | 'stop' | 'skip', by?: number) => Kea.readControl({ action, by }).catch(() => {}),
  subscribe: (cb: (p: { id: string; state: string }) => void) => {
    const sub = Kea.addListener('speech', cb);
    return () => sub.then((s) => s.remove());
  }
};

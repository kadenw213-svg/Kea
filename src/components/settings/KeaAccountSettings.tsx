// Settings → Kea account: how you use Kea (the same choices as after signing in), where the Kea Hub is, and how you
// show on class leaderboards.
import { ModeSettings } from '../ModePicker';
import { HubAddress, useHubStatus } from '../scholar/HubAccount';
import { BoardNameSetting } from '../scholar/BoardName';

export function KeaAccountSettings() {
  const status = useHubStatus();
  return (
    <div className="hubc-settings">
      <div className="sgroup-title sgroup-in">How you use Kea</div>
      <ModeSettings />
      <div className="sgroup-title sgroup-in">Kea Hub</div>
      {status?.signedIn && <p className="muted">Signed in as {status.me?.account.email ?? status.cached?.email}.</p>}
      <HubAddress />
      <div className="sgroup-title sgroup-in">On class leaderboards</div>
      <BoardNameSetting />
    </div>
  );
}

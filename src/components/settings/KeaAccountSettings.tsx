// Settings → Kea account: the account page itself (who you are, verifying your email, notifications, phone, sign-in
// and security, your data, signing out, the Hub's address), how you use Kea, and how you show on class leaderboards.
import { ModeSettings } from '../ModePicker';
import { HubPanel } from '../scholar/HubAccount';
import { BoardNameSetting } from '../scholar/BoardName';
import { useKeaModes } from '../../lib/modes';

export function KeaAccountSettings() {
  const modes = useKeaModes();
  return (
    <div className="hubc-settings">
      <HubPanel />
      <div className="sgroup-title sgroup-in">How you use Kea</div>
      <ModeSettings />
      {modes.school && (
        <>
          <div className="sgroup-title sgroup-in">On class leaderboards</div>
          <BoardNameSetting />
        </>
      )}
    </div>
  );
}

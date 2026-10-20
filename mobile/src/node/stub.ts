// Parts of Kea on the PC that the phone never runs (the class-site browser, scans): study.cjs only reaches for them while
// writing a new set, which the phone hands to the PC instead.
const unavailable = () => {
  throw new Error('Only Kea on your PC can do this.');
};
export const getJson = unavailable;
export const download = unavailable;
export default { getJson, download };

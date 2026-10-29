import { validateReportRange } from './malawiTime.js';

// Loads a manager report so that the result on screen ALWAYS belongs to the most recent
// request. `guard` is a createPagedLoadGuard(). Each call:
//   1. checks the range (an unusable range changes nothing: the report on screen and any
//      request already running are left alone, and onInvalid shows the reason);
//   2. reset()s the guard, so any older request is obsolete - its result, its error and
//      its loading indicator are ignored from now on;
//   3. fetches exactly this from/to, and hands apply() the SAME from/to that were fetched.
// The range is read when the call is made, never when the answer arrives.
export function requestReport(guard, { from, to, fetch, apply, onError, onInvalid, setLoading }) {
  const problem = validateReportRange(from, to);
  if (problem) { if (onInvalid) onInvalid(problem); return Promise.resolve(false); }
  guard.reset();
  return guard.run({
    setLoading,
    fetch: () => fetch({ from, to }),
    apply: (result) => apply(result, { from, to }),
    onError: onError && ((err) => onError(err, { from, to })),   // RC6.3: the error knows which dates failed
  });
}

/**
 * Public action surface for the demo flow.
 *
 * App.tsx consumes these via `import * as actions from '@/actions'`. Each
 * step (fetch challenge, build credential, local verify, submit) lives in its own file under `src/actions/`; this barrel
 * re-exports the names App.tsx uses.
 */

export { type ActionResult, errorPanel, recalcBaseUnits, resetPanelCounter } from './shared'
export { fetchChallengeFromServer } from './fetchChallenge'
export { type BuildCredentialContext, buildCredential } from './buildCredential'
export { localVerify } from './localVerify'
export { submitCredentialToServer } from './submit'
export {
  X402_ENDPOINT,
  buildX402Payment,
  fetchX402Offer,
  submitX402Payment,
  verifyX402Local,
} from './x402'

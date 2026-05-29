/**
 * Public action surface for the demo flow.
 *
 * App.tsx consumes these via `import * as actions from '@/actions'`. Each
 * step (fetch/issue challenge, build credential, local verify, build
 * receipt, submit) lives in its own file under `src/actions/`; this barrel
 * re-exports the names App.tsx uses.
 */

export {
  type ActionResult,
  DEMO_PERMIT2_SPENDER,
  DEMO_SECRET,
  errorPanel,
  recalcBaseUnits,
  resetPanelCounter,
} from './shared'
export { fetchChallengeFromServer } from './fetchChallenge'
export { issueChallengeLocal } from './issueChallenge'
export { type BuildCredentialContext, buildCredential } from './buildCredential'
export { localVerify } from './localVerify'
export { buildReceiptLocal } from './receipt'
export { submitCredentialToServer } from './submit'

# Security Policy

## Reporting a vulnerability

Please disclose security issues privately. Email the maintainers at
**security@bnbchain.org** with:

- a description of the vulnerability,
- reproduction steps or a proof of concept,
- the commit SHA or version where you observed the issue,
- the chain / token preset configuration in use, if relevant.

Please do not file a public GitHub issue for security reports. We will
acknowledge receipt within two business days and aim to ship a fix
within 30 days for high-severity findings.

## Scope

In scope:

- Double-spend / replay window in the EVM Charge verifier paths
- Challenge binding bypass (HMAC mismatch, stored-lookup confusion)
- Receipt forgery / wire field stripping
- Settlement signer escalation (key material leakage, address drift)
- Supply-chain risks specific to mppx / viem / ox transitive deps

Out of scope:

- General mppx framework issues — report upstream at
  [wevm/mppx](https://github.com/wevm/mppx)
- viem RPC provider behaviour
- Issues that require an attacker to already control the merchant's
  settlement signing keys

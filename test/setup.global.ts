// Global setup runs once before all test workers.
// Hook here to start mock RPC / preload shared fixtures when integration
// or live tests need them. Pure unit tests should not depend on anything here.

export async function setup() {
  // no-op for PR1
}

export async function teardown() {
  // no-op for PR1
}

import { checkCronCooldown, handleCronFailure, resetCronFailures } from '../src/cron.js';

async function runTest() {
  console.log("🧪 Testing Cooldown and Failure Tracker...\n");

  // 1. Initial state check
  console.log("Initial cooldown check (should be false):", checkCronCooldown());

  // 2. First failure
  console.log("\n[Test] Recording 1st failure...");
  handleCronFailure("Mock error 1");
  console.log("Cooldown check (should be false):", checkCronCooldown());

  // 3. Success resets failure count
  console.log("\n[Test] Recording success (should reset failure count)...");
  resetCronFailures();

  // 4. Triggering consecutive failures
  console.log("\n[Test] Recording 1st failure again...");
  handleCronFailure("Mock error A");
  console.log("[Test] Recording 2nd consecutive failure (this should trigger cooldown)...");
  handleCronFailure("Mock error B");

  // 5. Check cooldown status now
  console.log("\n[Test] Cooldown check (should be true):", checkCronCooldown());
}

runTest();

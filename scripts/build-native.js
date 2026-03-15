const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

const nativeModulePath = path.join(__dirname, '..', 'native-module');

function runCommand(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit', cwd: nativeModulePath });
}

if (os.platform() === 'darwin') {
  console.log('Building for macOS (darwin) for dual architectures...');
  
  try {
    runCommand('rustup target add x86_64-apple-darwin');
    runCommand('rustup target add aarch64-apple-darwin');
  } catch (err) {
    console.warn('Warning: Could not configure rust targets via rustup. Continuing anyway.');
  }

  console.log('\n--- Building for x64 ---');
  runCommand('npx napi build --platform --target x86_64-apple-darwin --release');

  console.log('\n--- Building for arm64 ---');
  runCommand('npx napi build --platform --target aarch64-apple-darwin --release');
  
} else {
  console.log(`Building for current platform: ${os.platform()}`);
  runCommand('npx napi build --platform --release');
}

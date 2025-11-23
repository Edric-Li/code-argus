/**
 * Example file for quick testing
 * Run with: npm run exec src/examples/demo.ts
 */

function demo() {
  console.log('Demo function running...');

  const data = {
    timestamp: new Date().toISOString(),
    message: 'Hello from Code Argus!'
  };

  console.log(data);
}

demo();

const fs = require('fs');
const content = fs.readFileSync('service-account.json', 'utf8');

try {
  JSON.parse(content);
  console.log('JSON is valid');
} catch (e) {
  console.error('JSON Error:', e.message);
  const pos = parseInt(e.message.match(/position (\d+)/)[1]);
  console.log('Error around position:', pos);
  console.log('Context:', content.substring(pos - 20, pos + 20));
  
  // Show char codes around that position
  for (let i = pos - 5; i <= pos + 5; i++) {
    console.log(`Pos ${i}: [${content[i]}] (code: ${content.charCodeAt(i)})`);
  }
}

const dns = require('dns');
const https = require('https');

console.log('🔍 Network Diagnostics\n');

// Test basic internet
console.log('1. Testing internet connectivity...');
https.get('https://www.google.com', (res) => {
  console.log('   ✅ Internet connection working');
  
  // Test DNS resolution
  console.log('2. Testing DNS resolution...');
  dns.resolve4('cluster0.eip9z.mongodb.net', (err, addresses) => {
    if (err) {
      console.log('   ❌ DNS resolution failed:', err.message);
      console.log('\n💡 DNS Issue Detected:');
      console.log('   This is usually caused by:');
      console.log('   - ISP blocking MongoDB domains');
      console.log('   - Firewall/antivirus blocking');
      console.log('   - Corporate network restrictions');
      console.log('   - DNS server issues');
    } else {
      console.log('   ✅ DNS resolution successful:', addresses);
    }
    
    // Test MongoDB domain specifically
    console.log('3. Testing MongoDB domain...');
    https.get('https://cloud.mongodb.com', (res) => {
      console.log('   ✅ MongoDB website accessible');
      console.log('\n🎉 Network seems fine. The issue might be:');
      console.log('   - MongoDB Atlas cluster down');
      console.log('   - IP not whitelisted in Atlas');
      console.log('   - Specific port blocking');
    }).on('error', (err) => {
      console.log('   ❌ Cannot reach MongoDB website:', err.message);
    });
  });
}).on('error', (err) => {
  console.log('   ❌ No internet connection:', err.message);
});
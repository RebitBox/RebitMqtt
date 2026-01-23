const mqtt = require('mqtt');
const fs = require('fs');

const client = mqtt.connect('mqtts://app.rebit-japan.com:8883', {
  username: 'mqttproduser',
  password: '2o25@pR0Du$3rW8tl',
  ca: fs.readFileSync('C:\\Users\\YY\\RebitMqtt\\certs\\app.rebit-japan.com.ca-bundle'),
  rejectUnauthorized: false
});

client.on('connect', () => {
  console.log('✅ Connected to MQTT');
  
  // Get command from command line argument
  const action = process.argv[2] || 'testBinFull';
  const binCode = parseInt(process.argv[3]) || 0;
  
  const command = {
    action: action,
    params: action === 'resetBinStatus' ? { resetAll: true } : { binCode: binCode }
  };
  
  console.log('📤 Sending command:', JSON.stringify(command, null, 2));
  
  client.publish('rvm/RVM-3101/commands', JSON.stringify(command), { qos: 1 }, (err) => {
    if (err) {
      console.error('❌ Error:', err);
    } else {
      console.log('✅ Command sent successfully!');
      console.log('⏳ Wait 2 seconds, then check your API...');
    }
    
    setTimeout(() => {
      client.end();
      process.exit(0);
    }, 2000);
  });
});

client.on('error', (err) => {
  console.error('❌ MQTT Error:', err.message);
  process.exit(1);
});
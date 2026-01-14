// Test booking submission
const fetch = require('node-fetch');

async function testBooking() {
    console.log('🧪 Testing booking submission...\n');
    
    const testBooking = {
        name: 'Test User',
        email: 'test@example.com',
        phone: '1234567890',
        company: 'Test Company',
        date: new Date().toISOString().split('T')[0],
        time: '2:00 PM',
        message: 'This is a test booking'
    };
    
    console.log('📤 Sending booking data:', JSON.stringify(testBooking, null, 2));
    
    try {
        const response = await fetch('http://localhost:3000/api/bookings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(testBooking)
        });
        
        const result = await response.json();
        
        if (response.ok) {
            console.log('\n✅ Booking created successfully!');
            console.log('Response:', JSON.stringify(result, null, 2));
        } else {
            console.error('\n❌ Booking failed!');
            console.error('Status:', response.status);
            console.error('Error:', result);
        }
        
    } catch (error) {
        console.error('\n❌ Request failed:', error.message);
    }
}

testBooking();



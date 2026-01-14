const nodemailer = require('nodemailer');
require('dotenv').config();

// Test email configuration
async function testEmail() {
    console.log('📧 Testing Email Configuration...');
    console.log('Email User:', process.env.EMAIL_USER ? '✅ Configured' : '❌ Missing');
    console.log('Email Pass:', process.env.EMAIL_PASS ? '✅ Configured' : '❌ Missing');
    
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.log('❌ Email configuration is incomplete. Please check your .env file.');
        return;
    }
    
    try {
        // Create transporter
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        
        // Verify connection
        await transporter.verify();
        console.log('✅ Email transporter verified successfully!');
        
        // Send test email
        const testEmailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER, // Send to yourself for testing
            subject: '🎉 Email Configuration Test - InfiNet Booking System',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="background: linear-gradient(135deg, #060097 0%, #57ffff 100%); color: white; padding: 30px; border-radius: 10px; text-align: center;">
                        <h1 style="margin: 0;">✅ Email Test Successful!</h1>
                        <p style="margin: 10px 0 0 0;">Your consultation booking system email is working perfectly.</p>
                    </div>
                    
                    <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
                        <h2 style="color: #060097;">📧 Email Configuration Details</h2>
                        <p><strong>From:</strong> ${process.env.EMAIL_USER}</p>
                        <p><strong>Status:</strong> ✅ Working</p>
                        <p><strong>Service:</strong> Gmail</p>
                        <p><strong>Test Time:</strong> ${new Date().toLocaleString()}</p>
                        
                        <div style="background: #e3f2fd; padding: 20px; border-radius: 8px; margin-top: 20px;">
                            <h3 style="color: #1976d2; margin-top: 0;">🎯 What This Means</h3>
                            <ul style="color: #666;">
                                <li>✅ Clients will receive booking confirmation emails</li>
                                <li>✅ Professional email templates are ready</li>
                                <li>✅ Email notifications are fully configured</li>
                                <li>✅ Your booking system is complete!</li>
                            </ul>
                        </div>
                    </div>
                </div>
            `
        };
        
        await transporter.sendMail(testEmailOptions);
        console.log('✅ Test email sent successfully!');
        console.log('📧 Check your inbox for the test email.');
        console.log('🎉 Email configuration is working perfectly!');
        
    } catch (error) {
        console.error('❌ Email test failed:', error.message);
        
        if (error.message.includes('Invalid login')) {
            console.log('💡 Check your Gmail App Password. Make sure it\'s correct.');
        } else if (error.message.includes('Less secure app access')) {
            console.log('💡 Make sure 2-Factor Authentication is enabled and you\'re using an App Password.');
        }
    }
}

// Run the test
testEmail();

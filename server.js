require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const twilio = require('twilio');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Twilio client
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// ============ DATABASE SCHEMA ============
async function initDatabase() {
    const queries = [
        `CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(15) UNIQUE NOT NULL,
            name VARCHAR(100),
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        
        `CREATE TABLE IF NOT EXISTS swaps (
            id SERIAL PRIMARY KEY,
            user_phone VARCHAR(15) REFERENCES users(phone),
            have_type VARCHAR(30) NOT NULL,
            have_network VARCHAR(20),
            have_amount DECIMAL(10,2),
            have_bundle_size VARCHAR(50),
            expiry_date DATE,
            urgency VARCHAR(20) DEFAULT 'normal',
            want_type VARCHAR(30) NOT NULL,
            want_network VARCHAR(20),
            want_amount DECIMAL(10,2),
            want_bundle_size VARCHAR(50),
            status VARCHAR(20) DEFAULT 'pending',
            match_id INTEGER,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        
        `CREATE TABLE IF NOT EXISTS matches (
            id SERIAL PRIMARY KEY,
            swap1_id INTEGER REFERENCES swaps(id),
            swap2_id INTEGER REFERENCES swaps(id),
            escrow_amount DECIMAL(10,2) DEFAULT 10,
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        
        `CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            match_id INTEGER REFERENCES matches(id),
            phone VARCHAR(15),
            amount DECIMAL(10,2),
            mpesa_code VARCHAR(50),
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW()
        )`
    ];
    
    for (const query of queries) {
        await pool.query(query);
    }
    console.log('✅ Database initialized');
}

// ============ API ENDPOINTS ============

// Health check
app.get('/', (req, res) => {
    res.json({ message: 'KiondoNet API is running', status: 'healthy' });
});

// Create a swap
app.post('/api/swaps', async (req, res) => {
    try {
        const {
            phone, name, have_type, have_network, have_amount,
            have_bundle_size, expiry_date, urgency, want_type,
            want_network, want_amount, want_bundle_size
        } = req.body;
        
        // Ensure user exists
        await pool.query(
            'INSERT INTO users (phone, name) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET name = $2',
            [phone, name]
        );
        
        // Create swap
        const result = await pool.query(
            `INSERT INTO swaps (user_phone, have_type, have_network, have_amount, 
             have_bundle_size, expiry_date, urgency, want_type, want_network, 
             want_amount, want_bundle_size, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
             RETURNING *`,
            [phone, have_type, have_network, have_amount, have_bundle_size,
             expiry_date, urgency, want_type, want_network, want_amount, want_bundle_size]
        );
        
        res.json({ success: true, swap: result.rows[0] });
    } catch (error) {
        console.error('Error creating swap:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all pending swaps
app.get('/api/swaps/pending', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM swaps WHERE status = 'pending' ORDER BY created_at DESC`
        );
        res.json({ swaps: result.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get user's swaps
app.get('/api/swaps/user/:phone', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM swaps WHERE user_phone = $1 ORDER BY created_at DESC`,
            [req.params.phone]
        );
        res.json({ swaps: result.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a swap
app.delete('/api/swaps/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM swaps WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ MATCHING ENGINE ============
app.post('/api/match', async (req, res) => {
    try {
        // Get all pending swaps
        const pending = await pool.query(
            `SELECT * FROM swaps WHERE status = 'pending'`
        );
        
        const matches = [];
        
        for (let i = 0; i < pending.rows.length; i++) {
            const swap1 = pending.rows[i];
            if (swap1.status !== 'pending') continue;
            
            for (let j = i + 1; j < pending.rows.length; j++) {
                const swap2 = pending.rows[j];
                
                // Check if they match
                const isMatch = (
                    swap1.have_network === swap2.want_network &&
                    swap1.want_network === swap2.have_network &&
                    Math.abs(swap1.have_amount - swap2.want_amount) <= 10
                );
                
                if (isMatch) {
                    // Create match record
                    const matchResult = await pool.query(
                        `INSERT INTO matches (swap1_id, swap2_id, status) 
                         VALUES ($1, $2, 'pending') RETURNING *`,
                        [swap1.id, swap2.id]
                    );
                    
                    // Update swap statuses
                    await pool.query(
                        `UPDATE swaps SET status = 'matched', match_id = $1 WHERE id IN ($2, $3)`,
                        [matchResult.rows[0].id, swap1.id, swap2.id]
                    );
                    
                    matches.push({ swap1, swap2, match: matchResult.rows[0] });
                    
                    // Send WhatsApp notifications
                    await sendMatchNotification(swap1.user_phone, swap2);
                    await sendMatchNotification(swap2.user_phone, swap1);
                }
            }
        }
        
        res.json({ success: true, matches: matches.length });
    } catch (error) {
        console.error('Matching error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ WHATSAPP NOTIFICATIONS ============
async function sendMatchNotification(userPhone, matchedSwap) {
    try {
        const message = `🎯 KiondoNet: Match found!\n\n` +
            `Someone wants to swap with you.\n` +
            `They have: ${matchedSwap.have_amount || matchedSwap.have_bundle_size} ${matchedSwap.have_network}\n` +
            `They want: ${matchedSwap.want_amount || matchedSwap.want_bundle_size}\n\n` +
            `Pay 10 KES escrow to proceed: https://kiondo.co.ke/pay`;
        
        await twilioClient.messages.create({
            body: message,
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: `whatsapp:${userPhone}`
        });
        
        console.log(`WhatsApp sent to ${userPhone}`);
    } catch (error) {
        console.error('WhatsApp error:', error);
    }
}

// ============ M-PESA INTEGRATION ============
app.post('/api/mpesa/stkpush', async (req, res) => {
    const { phone, amount, matchId } = req.body;
    
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(
        `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');
    
    const data = {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: `${process.env.BACKEND_URL}/api/mpesa/callback`,
        AccountReference: `KIONDO-${matchId}`,
        TransactionDesc: "KiondoNet escrow payment"
    };
    
    try {
        const token = await getMpesaToken();
        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            data,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        
        res.json(response.data);
    } catch (error) {
        console.error('M-Pesa error:', error);
        res.status(500).json({ error: error.message });
    }
});

async function getMpesaToken() {
    const auth = Buffer.from(
        `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');
    
    const response = await axios.get(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}` } }
    );
    
    return response.data.access_token;
}

// M-Pesa callback endpoint
app.post('/api/mpesa/callback', async (req, res) => {
    console.log('M-Pesa callback:', req.body);
    // Update payment status in database
    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// ============ START SERVER ============
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 KiondoNet backend running on port ${PORT}`);
    });
});

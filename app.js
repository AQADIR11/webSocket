const express = require('express');
const socketIO = require('socket.io');
const http = require('http');
const mysql = require('mysql2/promise');
const port = process.env.PORT || 7867
var app = express();
let server = http.createServer(app);
var io = socketIO(server,{
  cors: {
    origin: 'https://earn.codestrail.com',
  }
});

require('dotenv').config();


const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 2000,
    queueLimit: 0
});

const activeMiners = new Map();

// Mining configuration
const BASE_RATE = 10; // 1 coin per hour
const REFERRAL_BONUSES = [0.0025, 0.0020, 0.0015, 0.0010, 0.0005]; // 5 levels

// make connection with user from server side
io.on('connection', (socket) => {
        // Extract user ID from query params (for simplicity)
        const userId = socket.handshake.query.userId;
        if (!userId) throw new Error('User ID is required');
        var miningInterval = "";
        try {
            // Add miner to active list
            activeMiners.set(userId, socket);
            console.log(`Miner connected: ${userId}`);
    
            // Start mining interval
            miningInterval = setInterval(async () => {
                try {
                    // Calculate referral bonuses
                    const [referrals] = await pool.query(`
                      WITH RECURSIVE referral_tree AS (
                        SELECT referred_by AS top_referrer, referral_code, 1 AS level
                        FROM users
                        WHERE referred_by = (select referral_code from users where id = ?)
                        UNION ALL
                        SELECT u.referred_by AS top_referrer, u.referral_code, rt.level + 1
                        FROM users u
                        INNER JOIN referral_tree rt ON u.referred_by = rt.referral_code
                        WHERE rt.level < 5
                    )
                    
                    SELECT level, COUNT(*) AS active_count
                    FROM referral_tree rt
                    JOIN users u ON rt.referral_code = u.referral_code
                    WHERE u.mining_started_at >= NOW() AND u.is_mining_active = 1
                    GROUP BY level
                    ORDER BY level;
                    `, [userId]);
                    let multiplier = 1;
                    let referralsCount = 0
                    referrals.forEach(row => {
                        //if(row.is_mining_active){
                            multiplier += REFERRAL_BONUSES[row.level - 1] * row.active_count;
                            referralsCount += row.active_count;
                        //}
                    });
                    
                    // Calculate coins earned per second
                    const coinsPerSecond = (BASE_RATE * multiplier) / 3600;
                    
                    const [currentUser] = await pool.query(`SELECT UNIX_TIMESTAMP(mining_started_at) as mining_started, UNIX_TIMESTAMP(NOW()) as now, is_mining_active from users where id=?`,[userId]);
                    var startDate = new Date();
                    // Do your operations
                    var endDate   = new Date(currentUser[0].mining_started * 1000);
                    
                    var seconds = (endDate.getTime() - startDate.getTime()) / 1000;
                    
                    if(currentUser[0].mining_started > currentUser[0].now && currentUser[0].is_mining_active){
                        // Update user's coins
                        var miningStatus = 'Connected';
                        const [result] = await pool.query(`UPDATE users SET total_coins = total_coins + ?, mining_from = 'web', is_mining_active = 1 WHERE id = ?`, [coinsPerSecond, userId]);
                        
                    }else{
                        const [rr] = await pool.query(`UPDATE users SET mining_from = NULL, is_mining_active = 0 WHERE id = ?`, [userId]);
                        var miningStatus = 'Disconnected';
                    }
                    // Get updated balance
                    const [rows] = await pool.query(`SELECT total_coins, is_mining_active FROM users WHERE id = ?`, [userId]);
                    //emit message from server to user
                    socket.emit('newMessage',{
                        type: 'update',
                        data: {
                            coins: rows[0].total_coins,
                            rate: BASE_RATE * multiplier,
                            multiplier: multiplier,
                            referrals: referralsCount,
                            perSecend: coinsPerSecond,
                            mining: miningStatus,
                            cooldown:Math.floor(seconds)
                        }
                    });
    
                } catch (error) {
                    console.error('Mining error:', error);
                }
            }, 1000); // Update every second
    
        } catch (error) {
            console.log('Connection error:', error);
        }
        
        // when server disconnects from user
        socket.on('disconnect', async () => {
            clearInterval(miningInterval);
            // Update user's last active time
            await pool.query('UPDATE users SET mining_from = NULL WHERE id = ?', [userId]);
    
            activeMiners.delete(userId);
            console.log(`Miner disconnected: ${userId}`);
        });
    });

    app.get("/", (req, res) => {
        res.send("Hello");
    });

server.listen(port);
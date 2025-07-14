const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.sendStatus(401);
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret', (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Email configuration
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// API Routes

// Authentication
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '24h' }
    );
    
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        dealership_id: user.dealership_id
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get user profile
app.get('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, role, dealership_id FROM users WHERE id = $1',
      [req.user.userId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Leads management
app.get('/api/leads', authenticateToken, async (req, res) => {
  try {
    const { status, dealership_id } = req.query;
    let query = 'SELECT * FROM leads WHERE 1=1';
    const params = [];
    
    if (req.user.role !== 'admin') {
      query += ' AND dealership_id = $1';
      params.push(req.user.dealership_id);
    } else if (dealership_id) {
      query += ' AND dealership_id = $1';
      params.push(dealership_id);
    }
    
    if (status) {
      query += ` AND status = $${params.length + 1}`;
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({ error: 'Failed to get leads' });
  }
});

app.post('/api/leads', authenticateToken, async (req, res) => {
  try {
    const {
      customer_name,
      customer_email,
      customer_phone,
      vehicle_interest,
      source,
      notes,
      priority
    } = req.body;
    
    const result = await pool.query(
      `INSERT INTO leads (customer_name, customer_email, customer_phone, 
       vehicle_interest, source, notes, priority, status, assigned_to, 
       dealership_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING *`,
      [
        customer_name,
        customer_email,
        customer_phone,
        vehicle_interest,
        source,
        notes,
        priority || 'medium',
        'new',
        req.user.userId,
        req.user.dealership_id
      ]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create lead error:', error);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

app.put('/api/leads/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      customer_name,
      customer_email,
      customer_phone,
      vehicle_interest,
      status,
      notes,
      priority,
      assigned_to
    } = req.body;
    
    const result = await pool.query(
      `UPDATE leads SET 
       customer_name = COALESCE($1, customer_name),
       customer_email = COALESCE($2, customer_email),
       customer_phone = COALESCE($3, customer_phone),
       vehicle_interest = COALESCE($4, vehicle_interest),
       status = COALESCE($5, status),
       notes = COALESCE($6, notes),
       priority = COALESCE($7, priority),
       assigned_to = COALESCE($8, assigned_to),
       updated_at = NOW()
       WHERE id = $9 AND dealership_id = $10
       RETURNING *`,
      [
        customer_name,
        customer_email,
        customer_phone,
        vehicle_interest,
        status,
        notes,
        priority,
        assigned_to,
        id,
        req.user.dealership_id
      ]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update lead error:', error);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// Email processing endpoint
app.post('/api/process-email', async (req, res) => {
  try {
    const { from, subject, body, receivedDate } = req.body;
    
    // Extract lead information from email
    const leadData = extractLeadFromEmail(from, subject, body);
    
    if (leadData) {
      // Create new lead
      const result = await pool.query(
        `INSERT INTO leads (customer_name, customer_email, customer_phone,
         vehicle_interest, source, notes, priority, status, dealership_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          leadData.name,
          leadData.email,
          leadData.phone,
          leadData.vehicle,
          'email',
          leadData.notes,
          'medium',
          'new',
          1, // Default dealership
          new Date(receivedDate)
        ]
      );
      
      res.status(201).json({
        success: true,
        lead: result.rows[0]
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Could not extract lead information from email'
      });
    }
  } catch (error) {
    console.error('Email processing error:', error);
    res.status(500).json({ error: 'Failed to process email' });
  }
});

// Helper function to extract lead data from email
function extractLeadFromEmail(from, subject, body) {
  try {
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
    const phoneRegex = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/;
    
    const email = from.match(emailRegex)?.[0];
    const phone = body.match(phoneRegex)?.[0];
    
    // Extract name from email or body
    let name = from.split('@')[0].replace(/[._]/g, ' ');
    
    // Look for vehicle mentions
    const vehicles = ['toyota', 'honda', 'ford', 'chevrolet', 'nissan', 'bmw', 'mercedes', 'audi'];
    const vehicleMatch = vehicles.find(v => 
      body.toLowerCase().includes(v) || subject.toLowerCase().includes(v)
    );
    
    return {
      name: name,
      email: email,
      phone: phone,
      vehicle: vehicleMatch || 'Not specified',
      notes: `Email Subject: ${subject}\n\nEmail Body: ${body.substring(0, 500)}...`
    };
  } catch (error) {
    console.error('Error extracting lead data:', error);
    return null;
  }
}

// Analytics endpoint
app.get('/api/analytics', authenticateToken, async (req, res) => {
  try {
    const dealershipFilter = req.user.role === 'admin' ? '' : 'WHERE dealership_id = $1';
    const params = req.user.role === 'admin' ? [] : [req.user.dealership_id];
    
    const [leadStats, statusStats] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*) as total_leads,
          COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as leads_this_week,
          COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as leads_this_month
        FROM leads ${dealershipFilter}
      `, params),
      
      pool.query(`
        SELECT status, COUNT(*) as count
        FROM leads ${dealershipFilter}
        GROUP BY status
      `, params)
    ]);
    
    res.json({
      totals: leadStats.rows[0],
      statusBreakdown: statusStats.rows
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

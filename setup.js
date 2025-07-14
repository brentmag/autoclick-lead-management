const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function setupDatabase() {
  try {
    console.log('Setting up database...');

    // Create dealerships table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealerships (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        address TEXT,
        phone VARCHAR(20),
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'sales_rep',
        dealership_id INTEGER REFERENCES dealerships(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create leads table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255),
        customer_phone VARCHAR(20),
        vehicle_interest VARCHAR(255),
        source VARCHAR(100) DEFAULT 'manual',
        notes TEXT,
        priority VARCHAR(20) DEFAULT 'medium',
        status VARCHAR(50) DEFAULT 'new',
        assigned_to INTEGER REFERENCES users(id),
        dealership_id INTEGER REFERENCES dealerships(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create activities table for lead tracking
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id),
        user_id INTEGER REFERENCES users(id),
        activity_type VARCHAR(100) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create email_logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id SERIAL PRIMARY KEY,
        from_email VARCHAR(255),
        subject VARCHAR(500),
        body TEXT,
        processed BOOLEAN DEFAULT FALSE,
        lead_id INTEGER REFERENCES leads(id),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('Tables created successfully!');

    // Insert default dealership
    const dealershipResult = await pool.query(`
      INSERT INTO dealerships (name, address, phone, email)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [
      'AutoClick Motors',
      '123 Main Street, Anytown, USA',
      '(555) 123-4567',
      'info@autoclick.com'
    ]);

    let dealershipId;
    if (dealershipResult.rows.length > 0) {
      dealershipId = dealershipResult.rows[0].id;
      console.log('Default dealership created with ID:', dealershipId);
    } else {
      // Get existing dealership ID
      const existing = await pool.query('SELECT id FROM dealerships LIMIT 1');
      dealershipId = existing.rows[0].id;
      console.log('Using existing dealership ID:', dealershipId);
    }

    // Hash passwords
    const adminPassword = await bcrypt.hash('password123', 10);
    const repPassword = await bcrypt.hash('password123', 10);

    // Insert default admin user
    await pool.query(`
      INSERT INTO users (email, password, name, role, dealership_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET
        password = EXCLUDED.password,
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        dealership_id = EXCLUDED.dealership_id
    `, [
      'admin@autoclick.com',
      adminPassword,
      'Admin User',
      'admin',
      dealershipId
    ]);

    // Insert default sales rep user
    await pool.query(`
      INSERT INTO users (email, password, name, role, dealership_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET
        password = EXCLUDED.password,
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        dealership_id = EXCLUDED.dealership_id
    `, [
      'rep@autoclick.com',
      repPassword,
      'Sales Representative',
      'sales_rep',
      dealershipId
    ]);

    console.log('Default users created successfully!');

    // Insert sample leads
    const adminUser = await pool.query('SELECT id FROM users WHERE email = $1', ['admin@autoclick.com']);
    const adminUserId = adminUser.rows[0].id;

    const sampleLeads = [
      {
        name: 'John Smith',
        email: 'john.smith@email.com',
        phone: '(555) 123-4567',
        vehicle: 'Toyota Camry',
        source: 'website',
        notes: 'Interested in 2024 model, financing needed',
        priority: 'high'
      },
      {
        name: 'Sarah Johnson',
        email: 'sarah.j@email.com',
        phone: '(555) 987-6543',
        vehicle: 'Honda Accord',
        source: 'email',
        notes: 'Looking for reliable family car',
        priority: 'medium'
      },
      {
        name: 'Mike Wilson',
        email: 'mike.wilson@email.com',
        phone: '(555) 456-7890',
        vehicle: 'Ford F-150',
        source: 'phone',
        notes: 'Needs truck for work, cash buyer',
        priority: 'high'
      }
    ];

    for (const lead of sampleLeads) {
      await pool.query(`
        INSERT INTO leads (customer_name, customer_email, customer_phone, 
                          vehicle_interest, source, notes, priority, status, 
                          assigned_to, dealership_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT DO NOTHING
      `, [
        lead.name,
        lead.email,
        lead.phone,
        lead.vehicle,
        lead.source,
        lead.notes,
        lead.priority,
        'new',
        adminUserId,
        dealershipId
      ]);
    }

    console.log('Sample leads created successfully!');

    // Create indexes for better performance
    await pool.query('CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_leads_dealership ON leads(dealership_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at)');

    console.log('Database indexes created successfully!');
    console.log('✅ Database setup complete!');
    console.log('');
    console.log('🎯 Default Login Credentials:');
    console.log('Admin: admin@autoclick.com / password123');
    console.log('Sales Rep: rep@autoclick.com / password123');
    console.log('');

  } catch (error) {
    console.error('Database setup error:', error);
  } finally {
    await pool.end();
  }
}

// Run setup if this file is executed directly
if (require.main === module) {
  setupDatabase();
}

module.exports = { setupDatabase };

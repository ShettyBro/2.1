const sql = require('mssql');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
};

const JWT_SECRET = process.env.JWT_SECRET;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};


// ============================================================================
// MAIN HANDLER
// ============================================================================
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }
  
  let pool;
  try {
     const authHeader = event.headers.authorization || event.headers.Authorization;
        
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return {
            statusCode: 401,
            headers,
            body: JSON.stringify({
              success: false,
              message: "Token expired. Redirecting to login...",
              redirect: "https://vtufest2026.acharyahabba.com/",
            }),
          };
        }
    
        const token = authHeader.substring(7);
        let decoded;
    
        try {
          decoded = jwt.verify(token, JWT_SECRET);
        } catch (err) {
          return {
            statusCode: 401,
            headers,
            body: JSON.stringify({
              success: false,
              message: "Token expired. Redirecting to login...",
              redirect: "https://vtufest2026.acharyahabba.com/",
            }),
          };
        }
const role = decoded.role;
console.log('Decoded role:', role);

    if (decoded.role !== 'PRINCIPAL' && decoded.role !== 'MANAGER') {
      throw new Error('Unauthorized: Principal or Manager role required');
    }
    const auth = {
      user_id: decoded.user_id,
      college_id: decoded.college_id,
      role: decoded.role,
    };



    // Connect to database
    pool = await sql.connect(dbConfig);
    
    // ============================================
    // 1. GET COLLEGE INFO
    // ============================================
    const collegeResult = await pool
    .request()
    .input('college_id', sql.Int, auth.college_id)
    .query(`
      SELECT 
      college_code,
      college_name,
          place,
          max_quota,
          is_final_approved,
          final_approved_at
        FROM colleges
        WHERE college_id = @college_id
      `);

    if (collegeResult.recordset.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'College not found' }),
      };
    }

    const college = collegeResult.recordset[0];

    // ============================================
    // 2. COUNT TOTAL STUDENTS FROM COLLEGE
    // ============================================
    const totalStudentsResult = await pool
      .request()
      .input('college_id', sql.Int, auth.college_id)
      .query(`
        SELECT COUNT(*) AS total
        FROM students
        WHERE college_id = @college_id
      `);

    const total_students = totalStudentsResult.recordset[0].total;

    // ============================================
    // 3. COUNT STUDENTS WITH APPLICATIONS
    // ============================================
    const studentsWithAppsResult = await pool
      .request()
      .input('college_id', sql.Int, auth.college_id)
      .query(`
        SELECT COUNT(DISTINCT sa.student_id) AS total
        FROM student_applications sa
        INNER JOIN students s ON sa.student_id = s.student_id
        WHERE s.college_id = @college_id
      `);

    const students_with_applications = studentsWithAppsResult.recordset[0].total;

    // ============================================
    // 4. COUNT APPROVED STUDENTS
    // ============================================
    const approvedResult = await pool
      .request()
      .input('college_id', sql.Int, auth.college_id)
      .query(`
        SELECT COUNT(DISTINCT sa.student_id) AS total
        FROM student_applications sa
        INNER JOIN students s ON sa.student_id = s.student_id
        WHERE s.college_id = @college_id
          AND sa.status = 'APPROVED'
      `);

    const approved_students = approvedResult.recordset[0].total;

    // ============================================
    // 5. COUNT REJECTED STUDENTS
    // ============================================
    const rejectedResult = await pool
      .request()
      .input('college_id', sql.Int, auth.college_id)
      .query(`
        SELECT COUNT(DISTINCT sa.student_id) AS total
        FROM student_applications sa
        INNER JOIN students s ON sa.student_id = s.student_id
        WHERE s.college_id = @college_id
          AND sa.status = 'REJECTED'
      `);

    const rejected_students = rejectedResult.recordset[0].total;

    // ============================================
    // 6. COUNT ACCOMPANISTS
    // ============================================
    const accompanistsResult = await pool
      .request()
      .input('college_id', sql.Int, auth.college_id)
      .query(`
        SELECT COUNT(*) AS total
        FROM accompanists
        WHERE college_id = @college_id
      `);

    const accompanists_count = accompanistsResult.recordset[0].total;

    // ============================================
    // 7. GET ACCOMMODATION STATUS
    // ============================================
    const accommodationResult = await pool
      .request()
      .input('college_id', sql.Int, auth.college_id)
      .query(`
        SELECT 
          total_boys,
          total_girls,
          status,
          applied_at
        FROM accommodation_requests
        WHERE college_id = @college_id
      `);

    let accommodation = null;
    if (accommodationResult.recordset.length > 0) {
      const acc = accommodationResult.recordset[0];
      accommodation = {
        total_boys: acc.total_boys,
        total_girls: acc.total_girls,
        status: acc.status || 'PENDING',
        applied_at: acc.applied_at,
      };
    }

    // ============================================
    // 8. GET PAYMENT STATUS
    // ============================================
    const paymentResult = await pool
      .request()
      .input('college_id', sql.Int, auth.college_id)
      .query(`
        SELECT 
          status,
          uploaded_at,
          admin_remarks
        FROM payment_receipts
        WHERE college_id = @college_id
      `);

    let payment_status = null;
    if (paymentResult.recordset.length > 0) {
      const pay = paymentResult.recordset[0];
      payment_status = {
        status: pay.status,
        uploaded_at: pay.uploaded_at,
        admin_remarks: pay.admin_remarks,
      };
    }

    // ============================================
    // 9. CHECK IF TEAM MANAGER EXISTS (FOR PRINCIPAL)
    // ============================================
    let has_team_manager = false;
    if (auth.role === 'principal') {
      const managerResult = await pool
        .request()
        .input('college_id', sql.Int, auth.college_id)
        .query(`
          SELECT COUNT(*) AS total
          FROM users
          WHERE college_id = @college_id
            AND role = 'MANAGER'
            AND is_active = 1
        `);

      has_team_manager = managerResult.recordset[0].total > 0;
    }

    // ============================================
    // 10. CALCULATE QUOTA (APPROVED STUDENTS + ACCOMPANISTS)
    // ============================================
    const quota_used = approved_students + accompanists_count;

    // ============================================
    // 11. BUILD RESPONSE
    // ============================================
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          college: {
            college_code: college.college_code,
            college_name: college.college_name,
            place: college.place,
            max_quota: college.max_quota,
          },
          stats: {
            total_students,
            students_with_applications,
            approved_students,
            rejected_students,
            accompanists_count,
            quota_used,
            quota_remaining: college.max_quota - quota_used,
          },
          accommodation,
          payment_status,
          is_final_approved: college.is_final_approved === 1,
          final_approved_at: college.final_approved_at,
          has_team_manager, // Only for Principal
        },
      }),
    };
  } catch (error) {
    console.error('Error:', error);

    if (error.message.includes('Authorization') || error.message.includes('Unauthorized')) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: error.message }),
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        details: error.message,
      }),
    };
  } finally {
    if (pool) {
      await pool.close();
    }
  }
};
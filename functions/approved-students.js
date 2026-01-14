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

const verifyAuth = (event) => {
   try {
      // ============================================
      // STEP 1: VALIDATE JWT TOKEN
      // ============================================
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

      if (decoded.role !== 'principal' && decoded.role !== 'manager') {
        throw new Error('Unauthorized: Principal or Manager role required');
      }

      return {
        user_id: decoded.user_id,
        role: decoded.role,
        college_id: decoded.college_id,
      };
   } catch (error) {
      throw error;
   }
};

// ============================================================================
// ACTION: get_approved_students
// ============================================================================
const getApprovedStudents = async (pool, auth) => {
  const result = await pool
    .request()
    .input('college_id', sql.Int, auth.college_id)
    .query(`
      SELECT 
        sa.application_id,
        sa.student_id,
        s.full_name,
        s.usn,
        s.email,
        s.phone,
        sa.status
      FROM student_applications sa
      INNER JOIN students s ON sa.student_id = s.student_id
      WHERE s.college_id = @college_id
        AND sa.status = 'APPROVED'
      ORDER BY s.full_name ASC
    `);

  const students = [];

  for (const student of result.recordset) {
    // Get participating events
    const participatingResult = await pool
      .request()
      .input('student_id', sql.Int, student.student_id)
      .query(`
        SELECT e.event_id, e.event_name
        FROM student_event_participation sep
        INNER JOIN events e ON sep.event_id = e.event_id
        WHERE sep.student_id = @student_id
          AND sep.event_type = 'participating'
      `);

    // Get accompanying events
    const accompanyingResult = await pool
      .request()
      .input('student_id', sql.Int, student.student_id)
      .query(`
        SELECT e.event_id, e.event_name
        FROM student_event_participation sep
        INNER JOIN events e ON sep.event_id = e.event_id
        WHERE sep.student_id = @student_id
          AND sep.event_type = 'accompanying'
      `);

    students.push({
      application_id: student.application_id,
      student_id: student.student_id,
      full_name: student.full_name,
      usn: student.usn,
      email: student.email,
      phone: student.phone,
      participating_events: participatingResult.recordset.map(e => ({
        event_id: e.event_id,
        event_name: e.event_name,
      })),
      accompanying_events: accompanyingResult.recordset.map(e => ({
        event_id: e.event_id,
        event_name: e.event_name,
      })),
    });
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      students,
    }),
  };
};

// ============================================================================
// ACTION: edit_student_events
// ============================================================================
const editStudentEvents = async (pool, auth, body) => {
  const { student_id, participating_events, accompanying_events } = body;

  if (!student_id) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'student_id is required' }),
    };
  }

  const transaction = pool.transaction();
  await transaction.begin();

  try {
    // Check if final approval is locked
    const lockCheck = await transaction
      .request()
      .input('college_id', sql.Int, auth.college_id)
      .query(`
        SELECT is_final_approved
        FROM colleges
        WHERE college_id = @college_id
      `);

    if (lockCheck.recordset[0].is_final_approved === 1) {
      await transaction.rollback();
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Final approval is locked. Cannot edit events.' }),
      };
    }

    // Delete existing event assignments
    await transaction
      .request()
      .input('student_id', sql.Int, student_id)
      .query(`
        DELETE FROM student_event_participation
        WHERE student_id = @student_id
      `);

    // Insert new participating events
    if (participating_events && participating_events.length > 0) {
      for (const event_id of participating_events) {
        await transaction
          .request()
          .input('student_id', sql.Int, student_id)
          .input('event_id', sql.Int, event_id)
          .input('college_id', sql.Int, auth.college_id)
          .input('assigned_by_user_id', sql.Int, auth.user_id)
          .query(`
            INSERT INTO student_event_participation (
              student_id, event_id, college_id, assigned_by_user_id, event_type
            )
            VALUES (@student_id, @event_id, @college_id, @assigned_by_user_id, 'participating')
          `);
      }
    }

    // Insert new accompanying events
    if (accompanying_events && accompanying_events.length > 0) {
      for (const event_id of accompanying_events) {
        await transaction
          .request()
          .input('student_id', sql.Int, student_id)
          .input('event_id', sql.Int, event_id)
          .input('college_id', sql.Int, auth.college_id)
          .input('assigned_by_user_id', sql.Int, auth.user_id)
          .query(`
            INSERT INTO student_event_participation (
              student_id, event_id, college_id, assigned_by_user_id, event_type
            )
            VALUES (@student_id, @event_id, @college_id, @assigned_by_user_id, 'accompanying')
          `);
      }
    }

    await transaction.commit();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Events updated successfully',
      }),
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

// ============================================================================
// ACTION: move_to_rejected
// ============================================================================
const moveToRejected = async (pool, auth, body) => {
  const { student_id, rejection_reason } = body;

  if (!student_id || !rejection_reason) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'student_id and rejection_reason are required' }),
    };
  }

  // Check if final approval is locked
  const lockCheck = await pool
    .request()
    .input('college_id', sql.Int, auth.college_id)
    .query(`
      SELECT is_final_approved
      FROM colleges
      WHERE college_id = @college_id
    `);

  if (lockCheck.recordset[0].is_final_approved === 1) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: 'Final approval is locked. Cannot reject students.' }),
    };
  }

  // Update application status
  await pool
    .request()
    .input('student_id', sql.Int, student_id)
    .input('rejection_reason', sql.VarChar(500), rejection_reason)
    .query(`
      UPDATE student_applications
      SET 
        status = 'REJECTED',
        rejected_reason = @rejection_reason,
        reviewed_at = SYSUTCDATETIME()
      WHERE student_id = @student_id
    `);

  // Delete event assignments
  await pool
    .request()
    .input('student_id', sql.Int, student_id)
    .query(`
      DELETE FROM student_event_participation
      WHERE student_id = @student_id
    `);

  // Increment reapply_count
  await pool
    .request()
    .input('student_id', sql.Int, student_id)
    .query(`
      UPDATE students
      SET reapply_count = reapply_count + 1
      WHERE student_id = @student_id
    `);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: 'Student moved to rejected successfully',
    }),
  };
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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { action } = body;

  if (!action) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'action is required' }),
    };
  }

  let pool;
  try {
    const auth = verifyAuth(event);
    pool = await sql.connect(dbConfig);

    if (action === 'get_approved_students') {
      return await getApprovedStudents(pool, auth);
    } else if (action === 'edit_student_events') {
      return await editStudentEvents(pool, auth, body);
    } else if (action === 'move_to_rejected') {
      return await moveToRejected(pool, auth, body);
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid action' }),
      };
    }
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
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


    if (decoded.role !== 'PRINCIPAL' && decoded.role !== 'MANAGER') {
      throw new Error('Unauthorized: Principal or Manager role required');
    }
    const auth = {
      user_id: decoded.user_id,
      college_id: decoded.college_id,
      role: decoded.role,
    };
    return auth;
  } catch (error) {
    throw error;
  }
};

// ============================================================================
// ACTION: get_pending_applications
// ============================================================================
const getPendingApplications = async (pool, auth) => {
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
        s.gender,
        sa.blood_group,
        sa.address,
        sa.department,
        sa.year_of_study,
        sa.semester,
        sa.status,
        sa.submitted_at
      FROM student_applications sa
      INNER JOIN students s ON sa.student_id = s.student_id
      WHERE s.college_id = @college_id
        AND sa.status = 'SUBMITTED'
      ORDER BY sa.submitted_at DESC
    `);

  const applications = [];

  for (const app of result.recordset) {
    // Get documents
    const docsResult = await pool
      .request()
      .input('application_id', sql.Int, app.application_id)
      .query(`
        SELECT document_type, document_url
        FROM application_documents
        WHERE application_id = @application_id
      `);

    const documents = {};
    docsResult.recordset.forEach(doc => {
      documents[doc.document_type.toLowerCase()] = doc.document_url;
    });

    applications.push({
      application_id: app.application_id,
      student_id: app.student_id,
      full_name: app.full_name,
      usn: app.usn,
      email: app.email,
      phone: app.phone,
      gender: app.gender,
      blood_group: app.blood_group,
      address: app.address,
      department: app.department,
      year_of_study: app.year_of_study,
      semester: app.semester,
      status: app.status,
      submitted_at: app.submitted_at,
      documents,
    });
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      applications,
    }),
  };
};

// ============================================================================
// ACTION: approve_student
// ============================================================================
const approveStudent = async (pool, auth, body) => {
  const { application_id, participating_events, accompanying_events } = body;

  if (!application_id) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'application_id is required' }),
    };
  }

  if (!participating_events || !Array.isArray(participating_events)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'participating_events must be an array' }),
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
        body: JSON.stringify({ error: 'Final approval is locked. Cannot approve students.' }),
      };
    }

    // Get application details
    const appResult = await transaction
      .request()
      .input('application_id', sql.Int, application_id)
      .query(`
        SELECT student_id, status
        FROM student_applications
        WHERE application_id = @application_id
      `);

    if (appResult.recordset.length === 0) {
      await transaction.rollback();
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Application not found' }),
      };
    }

    const student_id = appResult.recordset[0].student_id;

    // Check quota (approved students + accompanists < 45)
    const quotaCheck = await transaction
      .request()
      .input('college_id', sql.Int, auth.college_id)
      .query(`
        SELECT 
          (SELECT COUNT(DISTINCT sa.student_id)
           FROM student_applications sa
           INNER JOIN students s ON sa.student_id = s.student_id
           WHERE s.college_id = @college_id AND sa.status = 'APPROVED') +
          (SELECT COUNT(*)
           FROM accompanists
           WHERE college_id = @college_id) AS quota_used
      `);

    const quota_used = quotaCheck.recordset[0].quota_used;

    if (quota_used >= 45) {
      await transaction.rollback();
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'College quota exceeded (45/45). Remove existing participants before adding new ones.' }),
      };
    }

    // Validate event limits for participating events
    for (const event_id of participating_events) {
      const eventCheck = await transaction
        .request()
        .input('event_id', sql.Int, event_id)
        .input('college_id', sql.Int, auth.college_id)
        .query(`
          SELECT 
            e.event_name,
            e.max_participants_per_college,
            (SELECT COUNT(*)
             FROM student_event_participation sep
             INNER JOIN students s ON sep.student_id = s.student_id
             WHERE sep.event_id = @event_id 
               AND s.college_id = @college_id
               AND sep.event_type = 'participating') AS current_count
          FROM events e
          WHERE e.event_id = @event_id
        `);

      if (eventCheck.recordset.length === 0) {
        await transaction.rollback();
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: `Event ID ${event_id} not found` }),
        };
      }

      const event = eventCheck.recordset[0];
      if (event.current_count >= event.max_participants_per_college) {
        await transaction.rollback();
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: `Event "${event.event_name}" is full (${event.current_count}/${event.max_participants_per_college})` }),
        };
      }
    }

    // Update application status
    await transaction
      .request()
      .input('application_id', sql.Int, application_id)
      .query(`
        UPDATE student_applications
        SET status = 'APPROVED', reviewed_at = SYSUTCDATETIME()
        WHERE application_id = @application_id
      `);

    // Insert participating events
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

    // Insert accompanying events
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
        message: 'Student approved successfully',
      }),
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

// ============================================================================
// ACTION: reject_student
// ============================================================================
const rejectStudent = async (pool, auth, body) => {
  const { application_id, rejection_reason } = body;

  if (!application_id || !rejection_reason) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'application_id and rejection_reason are required' }),
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

  // Get student_id from application
  const appResult = await pool
    .request()
    .input('application_id', sql.Int, application_id)
    .query(`
      SELECT student_id
      FROM student_applications
      WHERE application_id = @application_id
    `);

  if (appResult.recordset.length === 0) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Application not found' }),
    };
  }

  const student_id = appResult.recordset[0].student_id;

  // Update application status
  await pool
    .request()
    .input('application_id', sql.Int, application_id)
    .input('rejection_reason', sql.VarChar(500), rejection_reason)
    .query(`
      UPDATE student_applications
      SET 
        status = 'REJECTED',
        rejected_reason = @rejection_reason,
        reviewed_at = SYSUTCDATETIME()
      WHERE application_id = @application_id
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
      message: 'Student rejected successfully',
    }),
  };
};


// Add this new action before the MAIN HANDLER section

// ============================================================================
// ACTION: edit_student_details
// ============================================================================
const editStudentDetails = async (pool, auth, body) => {
  const {
    application_id,
    full_name,
    email,
    phone,
    gender,
    blood_group,
    address,
    department,
    year_of_study,
    semester
  } = body;

  if (!application_id) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'application_id is required' }),
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
      body: JSON.stringify({ error: 'Final approval is locked. Cannot edit students.' }),
    };
  }

  const transaction = pool.transaction();
  await transaction.begin();

  try {
    // Get student_id from application
    const appResult = await transaction
      .request()
      .input('application_id', sql.Int, application_id)
      .query(`
        SELECT student_id
        FROM student_applications
        WHERE application_id = @application_id
      `);

    if (appResult.recordset.length === 0) {
      await transaction.rollback();
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Application not found' }),
      };
    }

    const student_id = appResult.recordset[0].student_id;

    // Update students table
    await transaction
      .request()
      .input('student_id', sql.Int, student_id)
      .input('full_name', sql.VarChar(255), full_name)
      .input('email', sql.VarChar(255), email)
      .input('phone', sql.VarChar(20), phone)
      .input('gender', sql.VarChar(10), gender)
      .query(`
        UPDATE students
        SET 
          full_name = @full_name,
          email = @email,
          phone = @phone,
          gender = @gender
        WHERE student_id = @student_id
      `);

    // Update student_applications table
    await transaction
      .request()
      .input('application_id', sql.Int, application_id)
      .input('blood_group', sql.VarChar(5), blood_group)
      .input('address', sql.VarChar(500), address)
      .input('department', sql.VarChar(100), department)
      .input('year_of_study', sql.Int, year_of_study)
      .input('semester', sql.Int, semester)
      .query(`
        UPDATE student_applications
        SET 
          blood_group = @blood_group,
          address = @address,
          department = @department,
          year_of_study = @year_of_study,
          semester = @semester
        WHERE application_id = @application_id
      `);

    await transaction.commit();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Student details updated successfully',
      }),
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
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

    if (action === 'get_pending_applications') {
      return await getPendingApplications(pool, auth);
    } else if (action === 'approve_student') {
      return await approveStudent(pool, auth, body);
    } else if (action === 'reject_student') {
      return await rejectStudent(pool, auth, body);
    } else if (action === 'edit_student_details') {
      return await editStudentDetails(pool, auth, body);
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
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
    const auth = verifyAuth(event);
    
    // If auth returned an error response, return it
    if (auth.statusCode) {
      return auth;
    }

    pool = await sql.connect(dbConfig);

    const transaction = pool.transaction();
    await transaction.begin();

    try {
      // ======================================================================
      // STEP 1: Check if already finalized
      // ======================================================================
      const lockCheck = await transaction
        .request()
        .input('college_id', sql.Int, auth.college_id)
        .query(`
          SELECT is_final_approved
          FROM colleges
          WHERE college_id = @college_id
        `);

      if (lockCheck.recordset.length === 0) {
        await transaction.rollback();
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'College not found' }),
        };
      }

      if (lockCheck.recordset[0].is_final_approved === 1) {
        await transaction.rollback();
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Final approval already submitted' }),
        };
      }

      // ======================================================================
      // STEP 2: Get ELIGIBLE STUDENTS
      // Criteria: APPROVED status AND appears in at least ONE event table
      // Event tables are ONLY used for verification, NOT as data source
      // ======================================================================
      const eligibleStudentsResult = await transaction
        .request()
        .input('college_id', sql.Int, auth.college_id)
        .query(`
          SELECT DISTINCT
            s.student_id,
            s.full_name,
            s.phone,
            s.email,
            s.passport_photo_url
          FROM students s
          INNER JOIN student_applications sa ON s.student_id = sa.student_id
          WHERE s.college_id = @college_id
            AND sa.status = 'APPROVED'
            AND (
              EXISTS (SELECT 1 FROM event_mime WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_mimicry WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_one_act_play WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_skits WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_debate WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_elocution WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_quiz WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_cartooning WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_clay_modelling WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_collage_making WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_installation WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_on_spot_painting WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_poster_making WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_rangoli WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_spot_photography WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_classical_vocal_solo WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_classical_instr_percussion WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_classical_instr_non_percussion WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_light_vocal_solo WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_western_vocal_solo WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_group_song_indian WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_group_song_western WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_folk_orchestra WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_folk_dance WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
              OR EXISTS (SELECT 1 FROM event_classical_dance_solo WHERE student_id = s.student_id AND person_type = 'student' AND college_id = @college_id)
            )
        `);

      const eligibleStudents = eligibleStudentsResult.recordset;

      // ======================================================================
      // CRITICAL: FAIL if ZERO eligible students
      // ======================================================================
      if (eligibleStudents.length === 0) {
        await transaction.rollback();
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: 'Final approval failed. No eligible students found.',
            details: 'No approved students have been assigned to any events. Please assign students to events before final approval.',
          }),
        };
      }

      let inserted_students = 0;

      // ======================================================================
      // STEP 3: Insert STUDENTS into master table
      // Insert ONE row per student (not per event)
      // Data source: students table + student_applications table
      // ======================================================================
      for (const student of eligibleStudents) {
        // Get student documents from student_applications
        const docsResult = await transaction
          .request()
          .input('student_id', sql.Int, student.student_id)
          .query(`
            SELECT 
              ad.document_type,
              ad.document_url
            FROM student_applications sa
            LEFT JOIN application_documents ad ON sa.application_id = ad.application_id
            WHERE sa.student_id = @student_id
          `);

        const documents = {};
        docsResult.recordset.forEach(doc => {
          if (doc.document_type) {
            documents[doc.document_type.toLowerCase()] = doc.document_url;
          }
        });

        // Insert ONE row per student
        await transaction
          .request()
          .input('college_id', sql.Int, auth.college_id)
          .input('person_type', sql.VarChar(20), 'STUDENT')
          .input('student_id', sql.Int, student.student_id)
          .input('is_team_manager', sql.Bit, 0)
          .input('full_name', sql.VarChar(255), student.full_name)
          .input('phone', sql.VarChar(20), student.phone)
          .input('email', sql.VarChar(255), student.email)
          .input('photo_url', sql.VarChar(500), student.passport_photo_url)
          .input('aadhaar_url', sql.VarChar(500), documents.aadhar || null)
          .input('college_id_url', sql.VarChar(500), documents.college_id || null)
          .input('sslc_url', sql.VarChar(500), documents.sslc || null)
          .input('final_approved_at', sql.DateTime2, new Date())
          .input('final_approved_by', sql.Int, auth.user_id)
          .query(`
            INSERT INTO final_event_participants_master (
              college_id,
              person_type,
              student_id,
              accompanist_id,
              is_team_manager,
              full_name,
              phone,
              email,
              photo_url,
              aadhaar_url,
              college_id_url,
              sslc_url,
              accompanist_id_proof_url,
              final_approved_at,
              final_approved_by
            )
            VALUES (
              @college_id,
              @person_type,
              @student_id,
              NULL,
              @is_team_manager,
              @full_name,
              @phone,
              @email,
              @photo_url,
              @aadhaar_url,
              @college_id_url,
              @sslc_url,
              NULL,
              @final_approved_at,
              @final_approved_by
            )
          `);

        inserted_students++;
      }

      // ======================================================================
      // STEP 4: Get ALL accompanists (no event verification needed)
      // Includes regular accompanists AND team manager
      // ======================================================================
      const accompanistsResult = await transaction
        .request()
        .input('college_id', sql.Int, auth.college_id)
        .query(`
          SELECT 
            accompanist_id,
            full_name,
            phone,
            email,
            passport_photo_url,
            id_proof_url,
            accompanist_type,
            is_team_manager
          FROM accompanists
          WHERE college_id = @college_id
        `);

      const accompanists = accompanistsResult.recordset;
      let inserted_accompanists = 0;

      // ======================================================================
      // STEP 5: Insert ACCOMPANISTS into master table
      // Insert ONE row per accompanist
      // Data source: accompanists table only
      // ======================================================================
      for (const acc of accompanists) {
        await transaction
          .request()
          .input('college_id', sql.Int, auth.college_id)
          .input('person_type', sql.VarChar(20), 'ACCOMPANIST')
          .input('accompanist_id', sql.Int, acc.accompanist_id)
          .input('is_team_manager', sql.Bit, acc.is_team_manager || 0)
          .input('full_name', sql.VarChar(255), acc.full_name)
          .input('phone', sql.VarChar(20), acc.phone)
          .input('email', sql.VarChar(255), acc.email)
          .input('photo_url', sql.VarChar(500), acc.passport_photo_url)
          .input('accompanist_id_proof_url', sql.VarChar(500), acc.id_proof_url)
          .input('final_approved_at', sql.DateTime2, new Date())
          .input('final_approved_by', sql.Int, auth.user_id)
          .query(`
            INSERT INTO final_event_participants_master (
              college_id,
              person_type,
              student_id,
              accompanist_id,
              is_team_manager,
              full_name,
              phone,
              email,
              photo_url,
              aadhaar_url,
              college_id_url,
              sslc_url,
              accompanist_id_proof_url,
              final_approved_at,
              final_approved_by
            )
            VALUES (
              @college_id,
              @person_type,
              NULL,
              @accompanist_id,
              @is_team_manager,
              @full_name,
              @phone,
              @email,
              @photo_url,
              NULL,
              NULL,
              NULL,
              @accompanist_id_proof_url,
              @final_approved_at,
              @final_approved_by
            )
          `);

        inserted_accompanists++;
      }

      // ======================================================================
      // STEP 6: Set final approval lock on college
      // ======================================================================
      await transaction
        .request()
        .input('college_id', sql.Int, auth.college_id)
        .input('user_id', sql.Int, auth.user_id)
        .query(`
          UPDATE colleges
          SET 
            is_final_approved = 1,
            final_approved_at = SYSUTCDATETIME(),
            final_approved_by = @user_id
          WHERE college_id = @college_id
        `);

      // ======================================================================
      // COMMIT TRANSACTION - All or nothing
      // ======================================================================
      await transaction.commit();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'Final approval successful. All registrations are now locked.',
          inserted_students,
          inserted_accompanists,
          total_records: inserted_students + inserted_accompanists,
        }),
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Final Approval Error:', error);

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
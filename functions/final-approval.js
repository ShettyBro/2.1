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
    pool = await sql.connect(dbConfig);

    const transaction = pool.transaction();
    await transaction.begin();

    try {
      // Check if already finalized
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
          body: JSON.stringify({ error: 'Final approval already submitted' }),
        };
      }

      // Get all APPROVED students
      const studentsResult = await transaction
        .request()
        .input('college_id', sql.Int, auth.college_id)
        .query(`
          SELECT 
            sa.student_id,
            s.full_name,
            s.phone,
            s.email,
            s.passport_photo_url
          FROM student_applications sa
          INNER JOIN students s ON sa.student_id = s.student_id
          WHERE s.college_id = @college_id
            AND sa.status = 'APPROVED'
        `);

      const students = studentsResult.recordset;
      let inserted_students = 0;

      // Insert students into master table
      for (const student of students) {
        // Get participating events
        const participatingResult = await transaction
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
        const accompanyingResult = await transaction
          .request()
          .input('student_id', sql.Int, student.student_id)
          .query(`
            SELECT e.event_id, e.event_name
            FROM student_event_participation sep
            INNER JOIN events e ON sep.event_id = e.event_id
            WHERE sep.student_id = @student_id
              AND sep.event_type = 'accompanying'
          `);

        // Get student documents
        const docsResult = await transaction
          .request()
          .input('student_id', sql.Int, student.student_id)
          .query(`
            SELECT 
              sa.application_id,
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

        const event_in_ids = participatingResult.recordset.map(e => e.event_id).join(',');
        const event_in_names = participatingResult.recordset.map(e => e.event_name).join(',');
        const accompanist_in_names = accompanyingResult.recordset.map(e => e.event_name).join(',');

        // Insert one row per participating event
        for (const event of participatingResult.recordset) {
          await transaction
            .request()
            .input('person_id', sql.Int, student.student_id)
            .input('person_type', sql.VarChar(15), 'student')
            .input('full_name', sql.VarChar(255), student.full_name)
            .input('phone', sql.VarChar(20), student.phone)
            .input('email', sql.VarChar(255), student.email)
            .input('photo_url', sql.VarChar(500), student.passport_photo_url)
            .input('event_id', sql.Int, event.event_id)
            .input('college_id', sql.Int, auth.college_id)
            .input('event_type', sql.VarChar(20), 'participating')
            .input('event_in', sql.VarChar(255), event_in_ids)
            .input('accompanish_in', sql.VarChar(255), accompanist_in_names || null)
            .input('event_in_names', sql.VarChar(500), event_in_names)
            .input('accompanist_in_names', sql.VarChar(500), accompanist_in_names || null)
            .input('aadhaar_url', sql.VarChar(500), documents.aadhar || null)
            .input('college_id_url', sql.VarChar(500), documents.college_id || null)
            .input('sslc_url', sql.VarChar(500), documents.sslc || null)
            .query(`
              INSERT INTO final_event_participants_master (
                person_id, person_type, full_name, phone, email, photo_url,
                event_id, college_id, event_type, event_in, accompanish_in,
                event_in_names, accompanist_in_names,
                aadhaar_url, college_id_url, sslc_url
              )
              VALUES (
                @person_id, @person_type, @full_name, @phone, @email, @photo_url,
                @event_id, @college_id, @event_type, @event_in, @accompanish_in,
                @event_in_names, @accompanist_in_names,
                @aadhaar_url, @college_id_url, @sslc_url
              )
            `);

          inserted_students++;
        }
      }

      // Get all accompanists
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

      // Insert accompanists into master table
      for (const acc of accompanists) {
        // Get assigned events
        const eventsResult = await transaction
          .request()
          .input('accompanist_id', sql.Int, acc.accompanist_id)
          .query(`
            SELECT e.event_id, e.event_name
            FROM accompanist_event_participation aep
            INNER JOIN events e ON aep.event_id = e.event_id
            WHERE aep.accompanist_id = @accompanist_id
          `);

        const accompanist_in_names = eventsResult.recordset.map(e => e.event_name).join(',');

        // Insert one row per assigned event
        for (const event of eventsResult.recordset) {
          await transaction
            .request()
            .input('person_id', sql.Int, acc.accompanist_id)
            .input('person_type', sql.VarChar(15), 'accompanist')
            .input('full_name', sql.VarChar(255), acc.full_name)
            .input('phone', sql.VarChar(20), acc.phone)
            .input('email', sql.VarChar(255), acc.email)
            .input('photo_url', sql.VarChar(500), acc.passport_photo_url)
            .input('accompanist_type', sql.VarChar(20), acc.accompanist_type)
            .input('is_team_manager', sql.Bit, acc.is_team_manager || 0)
            .input('event_id', sql.Int, event.event_id)
            .input('college_id', sql.Int, auth.college_id)
            .input('event_type', sql.VarChar(20), 'accompanying')
            .input('accompanist_in_names', sql.VarChar(500), accompanist_in_names)
            .input('accompanist_id_proof_url', sql.VarChar(500), acc.id_proof_url)
            .query(`
              INSERT INTO final_event_participants_master (
                person_id, person_type, full_name, phone, email, photo_url,
                accompanist_type, is_team_manager,
                event_id, college_id, event_type,
                accompanist_in_names, accompanist_id_proof_url
              )
              VALUES (
                @person_id, @person_type, @full_name, @phone, @email, @photo_url,
                @accompanist_type, @is_team_manager,
                @event_id, @college_id, @event_type,
                @accompanist_in_names, @accompanist_id_proof_url
              )
            `);

          inserted_accompanists++;
        }
      }

      // Set final approval lock
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
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mcpClient } from '../index';

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to your OAuth2 credentials and token (use env var if set, otherwise fall back to project root via process.cwd())
const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(process.cwd(), 'gmail-credentials.json');
const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH || path.join(process.cwd(), 'gmail-token.json');
console.error('Gmail credentials path resolved to:', CREDENTIALS_PATH);
console.error('Gmail token path resolved to:', TOKEN_PATH);

// Scopes required for sending email
const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

/**
 * Loads OAuth2 credentials from file
 */
function loadCredentials() {
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
}

/**
 * Loads or requests OAuth2 token
 */
async function getOAuth2Client(): Promise<any> {
  const { client_secret, client_id, redirect_uris } = loadCredentials().installed || loadCredentials().web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Try to load token
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // If no token, get new one
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('Authorize this app by visiting this url:', authUrl);
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code: string = await new Promise(resolve => rl.question('Enter the code from that page here: ', resolve));
  rl.close();
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log('Token stored to', TOKEN_PATH);
  return oAuth2Client;
}

/**
 * Sends an email using Gmail API and OAuth2.
 * @param to - Recipient email address
 * @param subject - Email subject
 * @param body - Email body (plain text)
 */
export async function sendEmailWithGmailAPI(to: string, subject: string, body: string): Promise<void> {
  const auth = await getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  // Create the email
  const email = [
    `To: ${to}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ].join('\n');

  const encodedMessage = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  });
}

// Mastra tool definition for use in agents and workflows
export const sendEmailTool = createTool({
    id: 'send-email',
    description: 'Sends an email using the Gmail API. Provide recipient email, subject, and body.',
    inputSchema: z.object({
        to: z.string().email().describe('Recipient email address'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body (plain text)'),
    }),
    execute: async (context) => {
        const input = context.input || context.args || context.context || context || {};
        const { to, subject, body } = input;
        if (!to || !subject || !body) {
            throw new Error('Missing required input fields: to, subject, body');
        }
        try {
            await sendEmailWithGmailAPI(to, subject, body);
            return { success: true };
        } catch (err) {
            console.error('Gmail API error:', err);
            throw new Error(`Failed to send email: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
});

// Types for missing information detection
interface MissingInfoRecord {
    candidate_id: string;
    full_name: string | null;
    email: string | null;
    phone_number: string | null;
    business_unit_id: number | null;
    missing_fields: string[];
    recoverable_fields: string[];
    recovery_sources: {
        name_from_resume?: string;
        phone_from_resume?: string;
    };
    priority: 'Critical' | 'High' | 'Medium' | 'Low';
}

interface MissingInfoSummary {
    total_candidates: number;
    candidates_missing_phone: number;
    candidates_missing_name: number;
    candidates_missing_email: number;
    phone_recovery_rate: number;
    name_recovery_rate: number;
    recoverable_phones: number;
    recoverable_names: number;
}

// Enhanced tool to detect missing candidate information with recovery analysis
export const detectMissingInfoTool = createTool({
    id: 'detect-missing-info',
    description: 'Automatically discovers database schema and analyzes all contact/candidate tables for missing information. Identifies what can be recovered from related tables like resumes, forms, etc.',
    inputSchema: z.object({
        includeRecoveryAnalysis: z.boolean().optional().default(true).describe('Whether to analyze what missing information can be recovered from related tables'),
        limitResults: z.number().optional().default(50).describe('Maximum number of records to return'),
        priorityFilter: z.enum(['Critical', 'High', 'Medium', 'Low']).optional().describe('Filter by priority level'),
        autoDiscoverTables: z.boolean().optional().default(true).describe('Automatically discover and analyze all relevant tables'),
    }),
    execute: async (context, options) => {
        try {
            const input = context.input || context.args || context.context || {};
            const { includeRecoveryAnalysis = true, limitResults = 50, priorityFilter, autoDiscoverTables = true } = input;

            // Get the database tools from MCP client
            let databaseTools;
            try {
                databaseTools = await mcpClient.getTools();
            } catch (error) {
                return {
                    success: false,
                    error: 'Database connection failed',
                    message: 'Unable to connect to the PostgreSQL database via MCP.',
                    suggestion: 'Check that the MCP PostgreSQL server is running and properly configured.',
                    details: error instanceof Error ? error.message : String(error)
                };
            }

            const queryTool = databaseTools.query;
            if (!queryTool) {
                return {
                    success: false,
                    error: 'Database query tool not available',
                    message: 'The PostgreSQL query tool could not be found in the MCP server.',
                    availableTools: Object.keys(databaseTools),
                    suggestion: 'Check that the @modelcontextprotocol/server-postgres is properly configured.'
                };
            }

            // Step 1: Discover all tables in the database
            const discoveryQuery = `
                SELECT 
                    table_name,
                    column_name,
                    data_type,
                    is_nullable
                FROM information_schema.columns 
                WHERE table_schema = 'public' 
                ORDER BY table_name, ordinal_position;
            `;

            const schemaResult = await queryTool.execute({ input: { sql: discoveryQuery } });
            const schemaData = Array.isArray(schemaResult) ? schemaResult : [schemaResult];

            if (!schemaData || schemaData.length === 0) {
                return {
                    success: false,
                    error: 'No database tables found',
                    message: 'Could not find any tables in the public schema.',
                    suggestion: 'Check database connection and ensure tables exist.'
                };
            }

            // Step 2: Analyze schema to find main contact/candidate tables and related tables
            const tableAnalysis = analyzeTableSchema(schemaData);
            
            if (!tableAnalysis.mainTable) {
                return {
                    success: false,
                    error: 'No main contact/candidate table found',
                    message: 'Could not identify a primary table for contacts or candidates.',
                    availableTables: tableAnalysis.allTables,
                    suggestion: 'Ensure there is a table with fields like email, name, or phone for contact information.'
                };
            }

            // Step 3: Get summary statistics from the main table
            const summaryQuery = `
                WITH main_table_analysis AS (
                    SELECT 
                        COUNT(*) as total_records,
                        ${tableAnalysis.emailField ? `COUNT(${tableAnalysis.emailField}) as has_email,` : '0 as has_email,'}
                        ${tableAnalysis.phoneField ? `COUNT(${tableAnalysis.phoneField}) as has_phone,` : '0 as has_phone,'}
                        ${tableAnalysis.nameField ? `COUNT(${tableAnalysis.nameField}) as has_name,` : '0 as has_name,'}
                        ${tableAnalysis.emailField ? `COUNT(*) - COUNT(${tableAnalysis.emailField}) as missing_email,` : '0 as missing_email,'}
                        ${tableAnalysis.phoneField ? `COUNT(*) - COUNT(${tableAnalysis.phoneField}) as missing_phone,` : '0 as missing_phone,'}
                        ${tableAnalysis.nameField ? `COUNT(*) - COUNT(${tableAnalysis.nameField}) as missing_name` : '0 as missing_name'}
                    FROM ${tableAnalysis.mainTable}
                )
                SELECT 
                    total_records,
                    missing_email,
                    missing_phone,
                    missing_name,
                    ROUND((missing_phone * 100.0 / total_records), 2) as missing_phone_percentage,
                    ROUND((missing_email * 100.0 / total_records), 2) as missing_email_percentage,
                    ROUND((missing_name * 100.0 / total_records), 2) as missing_name_percentage
                FROM main_table_analysis;
            `;

            const summaryResult = await queryTool.execute({ input: { sql: summaryQuery } });
            const summary = Array.isArray(summaryResult) && summaryResult.length > 0 ? summaryResult[0] : summaryResult;

            // Step 4: Get detailed missing information with recovery analysis
            const detailedQuery = buildDetailedQuery(tableAnalysis, includeRecoveryAnalysis, limitResults);
            const detailedResult = await queryTool.execute({ input: { sql: detailedQuery } });
            const candidatesData = Array.isArray(detailedResult) ? detailedResult : [detailedResult];

            // Step 5: Process the data into our format
            const missingInfoReport: MissingInfoRecord[] = candidatesData
                .filter(record => record && (record.missing_email === 1 || record.missing_phone === 1 || record.missing_name === 1))
                .map((record: any) => {
                    const missingFields: string[] = [];
                    const recoverableFields: string[] = [];
                    const recoverySources: any = {};

                    if (record.missing_email === 1 && tableAnalysis.emailField) missingFields.push(tableAnalysis.emailField);
                    if (record.missing_phone === 1 && tableAnalysis.phoneField) {
                        missingFields.push(tableAnalysis.phoneField);
                        if (record.recoverable_phone) {
                            recoverableFields.push(tableAnalysis.phoneField);
                            recoverySources.phone_from_related = record.recoverable_phone.trim();
                        }
                    }
                    if (record.missing_name === 1 && tableAnalysis.nameField) {
                        missingFields.push(tableAnalysis.nameField);
                        if (record.recoverable_name) {
                            recoverableFields.push(tableAnalysis.nameField);
                            recoverySources.name_from_related = record.recoverable_name.trim();
                        }
                    }

                    const priority = categorizeCandidatePriority(missingFields, recoverableFields);

                    return {
                        candidate_id: String(record.record_id || record.id || 'unknown'),
                        full_name: record[tableAnalysis.nameField || 'name'] || null,
                        email: record[tableAnalysis.emailField || 'email'] || null,
                        phone_number: record[tableAnalysis.phoneField || 'phone'] || null,
                        business_unit_id: record.business_unit_id || null,
                        missing_fields: missingFields,
                        recoverable_fields: recoverableFields,
                        recovery_sources: recoverySources,
                        priority: priority
                    };
                });

            // Step 6: Filter by priority if specified
            const filteredReport = priorityFilter 
                ? missingInfoReport.filter(record => record.priority === priorityFilter)
                : missingInfoReport;

            // Step 7: Calculate recovery statistics
            const recoverablePhones = missingInfoReport.filter(r => r.recoverable_fields.some(f => f.includes('phone'))).length;
            const recoverableNames = missingInfoReport.filter(r => r.recoverable_fields.some(f => f.includes('name'))).length;
            const phoneRecoveryRate = summary.missing_phone > 0 ? Math.round((recoverablePhones / summary.missing_phone) * 100) : 0;
            const nameRecoveryRate = summary.missing_name > 0 ? Math.round((recoverableNames / summary.missing_name) * 100) : 0;

            const enhancedSummary: MissingInfoSummary = {
                total_candidates: summary.total_records,
                candidates_missing_phone: summary.missing_phone,
                candidates_missing_name: summary.missing_name,
                candidates_missing_email: summary.missing_email,
                phone_recovery_rate: phoneRecoveryRate,
                name_recovery_rate: nameRecoveryRate,
                recoverable_phones: recoverablePhones,
                recoverable_names: recoverableNames,
            };

            return {
                success: true,
                message: `Found ${filteredReport.length} records with missing information in table '${tableAnalysis.mainTable}'`,
                database_analysis: {
                    main_table: tableAnalysis.mainTable,
                    discovered_tables: tableAnalysis.allTables,
                    recovery_tables: tableAnalysis.recoveryTables,
                    field_mapping: {
                        email_field: tableAnalysis.emailField,
                        phone_field: tableAnalysis.phoneField,
                        name_field: tableAnalysis.nameField,
                        id_field: tableAnalysis.idField
                    }
                },
                summary: enhancedSummary,
                missing_info_report: filteredReport,
                recovery_analysis: includeRecoveryAnalysis ? {
                    total_recoverable: recoverablePhones + recoverableNames,
                    phone_recovery_available: recoverablePhones,
                    name_recovery_available: recoverableNames,
                    recovery_sources: tableAnalysis.recoveryTables,
                    recommended_actions: [
                        recoverableNames > 0 ? `Update ${recoverableNames} missing names from related tables` : null,
                        recoverablePhones > 0 ? `Update ${recoverablePhones} missing phone numbers from related tables` : null,
                        summary.missing_email > 0 ? `${summary.missing_email} records missing email addresses (critical - requires manual review)` : null
                    ].filter(Boolean)
                } : null,
                query_info: {
                    included_recovery_analysis: includeRecoveryAnalysis,
                    results_limited_to: limitResults,
                    priority_filter: priorityFilter || 'none',
                    auto_discovered_schema: autoDiscoverTables
                }
            };

        } catch (error) {
            console.error('Error detecting missing information:', error);
            return {
                success: false,
                error: 'Failed to detect missing information',
                message: error instanceof Error ? error.message : String(error),
                suggestion: 'Check database connection and table structure'
            };
        }
    },
});

// Helper function to analyze database schema and identify relevant tables
function analyzeTableSchema(schemaData: any[]) {
    const tableColumns: { [tableName: string]: string[] } = {};
    
    // Group columns by table
    schemaData.forEach(row => {
        if (!tableColumns[row.table_name]) {
            tableColumns[row.table_name] = [];
        }
        tableColumns[row.table_name].push(row.column_name.toLowerCase());
    });

    const allTables = Object.keys(tableColumns);
    
    // Identify main contact/candidate table
    let mainTable = '';
    let emailField = '';
    let phoneField = '';
    let nameField = '';
    let idField = '';
    
    // Look for tables that likely contain contact information
    const candidateTablePatterns = ['candidates', 'contacts', 'users', 'people', 'customers', 'clients'];
    const emailFieldPatterns = ['email', 'email_address', 'contact_email', 'mail'];
    const phoneFieldPatterns = ['phone', 'phone_number', 'contact_phone', 'mobile', 'telephone'];
    const nameFieldPatterns = ['name', 'full_name', 'first_name', 'last_name', 'contact_name'];
    const idFieldPatterns = ['id', 'candidate_id', 'contact_id', 'user_id', 'person_id'];

    // Find the best matching table
    for (const tableName of allTables) {
        const columns = tableColumns[tableName];
        const hasContactFields = columns.some(col => 
            emailFieldPatterns.some(pattern => col.includes(pattern)) ||
            phoneFieldPatterns.some(pattern => col.includes(pattern)) ||
            nameFieldPatterns.some(pattern => col.includes(pattern))
        );
        
        if (hasContactFields) {
            const tableScore = candidateTablePatterns.reduce((score, pattern) => {
                return score + (tableName.toLowerCase().includes(pattern) ? 10 : 0);
            }, 0) + columns.length; // Prefer tables with more columns as they're likely main tables
            
            if (tableScore > 0 && !mainTable) {
                mainTable = tableName;
                
                // Find the best matching fields
                emailField = columns.find(col => emailFieldPatterns.some(pattern => col.includes(pattern))) || '';
                phoneField = columns.find(col => phoneFieldPatterns.some(pattern => col.includes(pattern))) || '';
                nameField = columns.find(col => nameFieldPatterns.some(pattern => col.includes(pattern))) || '';
                idField = columns.find(col => idFieldPatterns.some(pattern => col.includes(pattern))) || 'id';
            }
        }
    }

    // Identify potential recovery tables (resumes, forms, etc.)
    const recoveryTables = allTables.filter(tableName => {
        return tableName.toLowerCase().includes('resume') ||
               tableName.toLowerCase().includes('form') ||
               tableName.toLowerCase().includes('application') ||
               tableName.toLowerCase().includes('profile') ||
               tableName.toLowerCase().includes('information');
    });

    return {
        mainTable,
        emailField,
        phoneField,
        nameField,
        idField,
        allTables,
        recoveryTables,
        tableColumns
    };
}

// Helper function to build the detailed query based on discovered schema
function buildDetailedQuery(tableAnalysis: any, includeRecoveryAnalysis: boolean, limitResults: number): string {
    const { mainTable, emailField, phoneField, nameField, idField, recoveryTables } = tableAnalysis;
    
    if (!includeRecoveryAnalysis || recoveryTables.length === 0) {
        return `
            SELECT 
                ${idField} as record_id,
                ${emailField ? emailField : 'NULL'} as email,
                ${phoneField ? phoneField : 'NULL'} as phone,
                ${nameField ? nameField : 'NULL'} as name,
                ${emailField ? `CASE WHEN ${emailField} IS NULL THEN 1 ELSE 0 END as missing_email,` : '0 as missing_email,'}
                ${phoneField ? `CASE WHEN ${phoneField} IS NULL THEN 1 ELSE 0 END as missing_phone,` : '0 as missing_phone,'}
                ${nameField ? `CASE WHEN ${nameField} IS NULL THEN 1 ELSE 0 END as missing_name` : '0 as missing_name'}
            FROM ${mainTable}
            WHERE ${emailField ? `${emailField} IS NULL OR` : ''} 
                  ${phoneField ? `${phoneField} IS NULL OR` : ''} 
                  ${nameField ? `${nameField} IS NULL` : 'FALSE'}
            ORDER BY 
                (${emailField ? `CASE WHEN ${emailField} IS NULL THEN 1 ELSE 0 END` : '0'} + 
                 ${phoneField ? `CASE WHEN ${phoneField} IS NULL THEN 1 ELSE 0 END` : '0'} + 
                 ${nameField ? `CASE WHEN ${nameField} IS NULL THEN 1 ELSE 0 END` : '0'}) DESC,
                ${idField}
            LIMIT ${limitResults};
        `;
    }

    // Build recovery query for the first available recovery table
    const recoveryTable = recoveryTables[0];
    
    return `
        WITH missing_records AS (
            SELECT 
                ${idField} as record_id,
                ${emailField || 'NULL'} as email,
                ${phoneField || 'NULL'} as phone,
                ${nameField || 'NULL'} as name,
                ${emailField ? `CASE WHEN ${emailField} IS NULL THEN 1 ELSE 0 END as missing_email,` : '0 as missing_email,'}
                ${phoneField ? `CASE WHEN ${phoneField} IS NULL THEN 1 ELSE 0 END as missing_phone,` : '0 as missing_phone,'}
                ${nameField ? `CASE WHEN ${nameField} IS NULL THEN 1 ELSE 0 END as missing_name` : '0 as missing_name'}
            FROM ${mainTable}
            WHERE ${emailField ? `${emailField} IS NULL OR` : ''} 
                  ${phoneField ? `${phoneField} IS NULL OR` : ''} 
                  ${nameField ? `${nameField} IS NULL` : 'FALSE'}
        ),
        recovery_analysis AS (
            SELECT 
                mr.*,
                r.content_json->>'name' as recoverable_name,
                r.content_json->>'contact' as recoverable_contact,
                CASE 
                    WHEN mr.missing_phone = 1 AND r.content_json->>'contact' ~ '\\+?[\\d\\s\\-\\(\\)]{8,}' 
                    THEN (regexp_matches(r.content_json->>'contact', '\\+?[\\d\\s\\-\\(\\)]{8,}', 'g'))[1]
                    ELSE NULL 
                END as recoverable_phone
            FROM missing_records mr
            LEFT JOIN ${recoveryTable} r ON r.${idField.replace('id', 'candidate_id')} = mr.record_id OR r.candidate_id = mr.record_id
        )
        SELECT * FROM recovery_analysis
        ORDER BY 
            (missing_email + missing_phone + missing_name) DESC,
            record_id
        LIMIT ${limitResults};
    `;
}

// Helper function to categorize urgency specifically for candidates
function categorizeCandidatePriority(missingFields: string[], recoverableFields: string[]): 'Critical' | 'High' | 'Medium' | 'Low' {
    const hasMissingEmail = missingFields.includes('email');
    const hasMissingPhone = missingFields.includes('phone_number');
    const hasMissingName = missingFields.includes('full_name');
    
    // Critical: Missing email (can't contact)
    if (hasMissingEmail) return 'Critical';
    
    // High: Missing both phone and name
    if (hasMissingPhone && hasMissingName) return 'High';
    
    // Medium: Missing phone or name but not recoverable
    if ((hasMissingPhone && !recoverableFields.includes('phone_number')) ||
        (hasMissingName && !recoverableFields.includes('full_name'))) {
        return 'Medium';
    }
    
    // Low: Missing info but recoverable
    return 'Low';
}

// Export all tools to be used by the agent
export async function getAllTools() {
    try {
        const databaseTools = await mcpClient.getTools();
        console.log('Database tools loaded:', Object.keys(databaseTools));
        
        return { 
            ...databaseTools, 
            sendEmail: sendEmailTool,
            detectMissingInfo: detectMissingInfoTool
        };
    } catch (error) {
        console.error('Error loading database tools from MCP:', error);
        console.log('Falling back to tools without database access');
        
        return { 
            sendEmail: sendEmailTool,
            detectMissingInfo: detectMissingInfoTool
        }; // Fallback with custom tools
    }
}

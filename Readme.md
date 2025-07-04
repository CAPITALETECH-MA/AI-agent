Based on my exploration of the database schema, there is no specific table or flag that automatically tracks missing information. The way to identify missing data is by actively querying the database for NULL or empty values in columns like phone_number, or by checking for the absence of related records in tables like resume_contract_type_preferences.

Your project to build a Mastra agent to automate this process is an excellent idea. The agent would essentially perform the same logic I used:

Identify: Run SQL queries to find candidates with missing information.
Contact: Use a tool (like the gmail-api-tool.ts I see you have) to send a templated email to the candidate.
Process: When the candidate replies, the agent would parse the email to extract the missing information.
Update: The agent would then update the database with the information it collected.
This is a perfect workflow to automate with an agent. I can certainly help you build it.
#!/bin/bash

# Read the original routes.ts file
FILE="server/routes.ts"

# Add crypto import at the top
if ! grep -q "import crypto from \"crypto\"" "$FILE"; then
    sed -i '1i import crypto from "crypto";' "$FILE"
fi

# Add session management code after the imports
# Find the line after the last import
import_end_line=$(grep -n "^import" "$FILE" | tail -1 | cut -d: -f1)

# Check if session management already exists
if ! grep -q "// Session management" "$FILE"; then
    # Add session management code after the imports
    session_code="\n\n// Session management\ninterface Session {\n  userId: string;\n  token: string;\n  expiresAt: number;\n}\n\nconst activeSessions = new Map<string, Session>();\nconst SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours\n\n// Generate a secure random token\nfunction generateToken(): string {\n  return crypto.randomBytes(32).toString(\"hex\");\n}\n\n// Clean up expired sessions\nfunction cleanupSessions(): void {\n  const now = Date.now();\n  for (const [token, session] of activeSessions.entries()) {\n    if (session.expiresAt < now) {\n      activeSessions.delete(token);\n    }\n  }\n}\n\n// Validate session token\nfunction validateSessionToken(token: string): Session | null {\n  cleanupSessions();\n  return activeSessions.get(token) || null;\n}\n\n"
    sed -i "${import_end_line}a $session_code" "$FILE"
fi

# Find the registerRoutes function
register_line=$(grep -n "export async function registerRoutes" "$FILE" | cut -d: -f1)

# Add login routes before registerRoutes
login_routes="\n\n// Login and logout routes\napp.post(\"/api/login\", async (req, res) => {\n  try {\n    const { adminSecret } = req.body;\n    \n    if (!adminSecret) {\n      return res.status(400).json({ error: \"Missing adminSecret in request body\" });\n    }\n    \n    // Validate against ADMIN_SECRET\n    if (!ADMIN_SECRET || adminSecret !== ADMIN_SECRET) {\n      return res.status(401).json({ error: \"Invalid admin secret\" });\n    }\n    \n    // Generate session token\n    const token = generateToken();\n    const session: Session = {\n      userId: \"admin\",\n      token,\n      expiresAt: Date.now() + SESSION_TIMEOUT_MS,\n    };\n    \n    activeSessions.set(token, session);\n    \n    // Return session token\n    res.json({\n      success: true,\n      token,\n      expiresAt: session.expiresAt,\n      message: \"Login successful\"\n    });\n    \n  } catch (error) {\n    console.error(\"Login error:\", error);\n    res.status(500).json({ error: \"Internal server error during login\" });\n  }\n});\n\napp.post(\"/api/logout\", async (req, res) => {\n  try {\n    const { token } = req.body;\n    \n    if (!token) {\n      return res.status(400).json({ error: \"Missing token in request body\" });\n    }\n    \n    // Remove session\n    const deleted = activeSessions.delete(token);\n    \n    res.json({\n      success: true,\n      message: deleted ? \"Logged out successfully\" : \"No active session found\"\n    });\n    \n  } catch (error) {\n    console.error(\"Logout error:\", error);\n    res.status(500).json({ error: \"Internal server error during logout\" });\n  }\n});\n\n"

if [ -n "$register_line" ]; then
    sed -i "$((register_line-1)),$((register_line-1))r \"<(printf \"$login_routes\")\"" "$FILE"
fi

echo "Login system added successfully!"

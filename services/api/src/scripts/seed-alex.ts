/**
 * Atlas — Seed/Update User: Alex
 *
 * Upserts Alex's account with correct email and password.
 * If handle "a13xperi" exists, updates email + password.
 * If not, creates the account.
 *
 * Run: npx tsx services/api/src/scripts/seed-alex.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const ALEX_EMAIL = "alex.e.peri@gmail.com";
const ALEX_PASSWORD = "Adinkra13!!";
const ALEX_HANDLE = "a13xperi";

async function main() {
  console.log("🌱 Upserting user: Alex\n");

  const passwordHash = await bcrypt.hash(ALEX_PASSWORD, 10);

  // Check by handle first
  const byHandle = await prisma.user.findUnique({ where: { handle: ALEX_HANDLE } });

  if (byHandle) {
    // Update existing account with correct email and password
    const updated = await prisma.user.update({
      where: { handle: ALEX_HANDLE },
      data: {
        email: ALEX_EMAIL,
        passwordHash,
        displayName: "Alex Peri",
      },
    });
    console.log(`✅ Updated existing user "${ALEX_HANDLE}" (${updated.id})`);
    console.log(`   Email: ${ALEX_EMAIL}`);
    console.log(`   Password: updated`);
    console.log(`   Role: ${updated.role}`);
    return;
  }

  // Check by email
  const byEmail = await prisma.user.findUnique({ where: { email: ALEX_EMAIL } });

  if (byEmail) {
    const updated = await prisma.user.update({
      where: { email: ALEX_EMAIL },
      data: {
        handle: ALEX_HANDLE,
        passwordHash,
        displayName: "Alex Peri",
      },
    });
    console.log(`✅ Updated existing user by email (${updated.id})`);
    console.log(`   Handle: ${ALEX_HANDLE}`);
    console.log(`   Password: updated`);
    return;
  }

  // Create new
  const user = await prisma.user.create({
    data: {
      handle: ALEX_HANDLE,
      email: ALEX_EMAIL,
      passwordHash,
      displayName: "Alex Peri",
      role: "MANAGER",
    },
  });

  console.log(`✅ Created new user "${ALEX_HANDLE}" (${user.id})`);
  console.log(`   Email: ${ALEX_EMAIL}`);
  console.log(`   Role: ${user.role}`);
}

main()
  .catch((e) => {
    console.error("❌ Failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

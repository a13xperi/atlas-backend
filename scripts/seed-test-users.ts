import { prisma } from "../services/api/src/lib/prisma";
import { config } from "../services/api/src/lib/config";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

async function main() {
  const testUsers = [
    { handle: "test-anil", email: "test-anil@delphi.io", role: "ANALYST", xHandle: "ani_bhat" },
    { handle: "test-alex", email: "test-alex@delphi.io", role: "ANALYST", xHandle: "a13xperi" },
    { handle: "test-demo", email: "test-demo@delphi.io", role: "ANALYST", xHandle: "VitalikButerin" },
  ];

  console.log('Seeding test users for Atlas flow testing...');

  for (const u of testUsers) {
    const user = await prisma.user.upsert({
      where: { handle: u.handle },
      update: {
        email: u.email,
        role: u.role as any,
        xHandle: u.xHandle,
      },
      create: {
        handle: u.handle,
        email: u.email,
        role: u.role as any,
        xHandle: u.xHandle,
      },
    });

    await prisma.voiceProfile.upsert({
      where: { userId: user.id },
      update: {
        tweetsAnalyzed: 0,
        maturity: "BEGINNER",
        // dimensions default to 50, reset calibration
        humor: 50,
        formality: 50,
        brevity: 50,
        contrarianTone: 50,
        directness: 50,
        warmth: 50,
        technicalDepth: 50,
        confidence: 50,
        evidenceOrientation: 50,
        solutionOrientation: 50,
        socialPosture: 50,
        selfPromotionalIntensity: 50,
        analysis: null,
      },
      create: {
        userId: user.id,
        tweetsAnalyzed: 0,
        maturity: "BEGINNER",
      },
    });

    const jti = randomUUID();
    const token = jwt.sign({ userId: user.id, jti }, config.JWT_SECRET, { expiresIn: "7d" });

    console.log(JSON.stringify({ userId: user.id, handle: user.handle, loginToken: token }, null, 2));
  }
  
  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

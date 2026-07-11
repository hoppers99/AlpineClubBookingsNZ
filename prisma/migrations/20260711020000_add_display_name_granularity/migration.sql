-- CreateEnum
CREATE TYPE "DisplayNameGranularity" AS ENUM ('FULL_NAME', 'FIRST_NAME_SURNAME_INITIAL', 'FIRST_NAME_ONLY', 'COUNTS_ONLY');

-- AlterTable
ALTER TABLE "Lodge" ADD COLUMN     "displayNameGranularity" "DisplayNameGranularity";


-- CreateTable
CREATE TABLE "place_searches" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "covered_meters" INTEGER NOT NULL,
    "searched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "place_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learned_places" (
    "place_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "saved_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "learned_places_pkey" PRIMARY KEY ("place_id","category")
);

-- CreateIndex
CREATE INDEX "place_searches_category_latitude_longitude_idx" ON "place_searches"("category", "latitude", "longitude");

-- CreateIndex
CREATE INDEX "place_searches_searched_at_idx" ON "place_searches"("searched_at");

-- CreateIndex
CREATE INDEX "learned_places_category_latitude_longitude_idx" ON "learned_places"("category", "latitude", "longitude");

-- CreateIndex
CREATE INDEX "learned_places_saved_at_idx" ON "learned_places"("saved_at");


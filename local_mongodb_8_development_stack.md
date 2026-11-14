services:
  mongodb8:
    image: mongo:8.0
    container_name: litemongo-local-db
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_DATABASE: insurance_dev
    volumes:
      - ./mongo-seed.js:/docker-entrypoint-initdb.d/mongo-seed.js:ro
      - mongo8_data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  mongo8_data:
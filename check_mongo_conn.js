require('dotenv').config();
console.log("PORT:", process.env.PORT);
console.log("URI DEFINED:", !!process.env.MONGODB_URI);

const { MongoClient } = require('mongodb');
if (process.env.MONGODB_URI) {
  const client = new MongoClient(process.env.MONGODB_URI);
  client.connect()
    .then(() => {
      console.log("SUCCESS: Connected to Atlas!");
      process.exit(0);
    })
    .catch(e => {
      console.error("FAILURE:", e.message);
      process.exit(1);
    });
} else {
  console.log("No MONGODB_URI in .env");
}

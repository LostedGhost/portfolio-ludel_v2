try {
  const { MongoClient } = require('mongodb');
  console.log("SUCCESS: mongodb module is available.");
} catch (e) {
  console.error("FAILURE: mongodb module NOT found:", e.message);
}

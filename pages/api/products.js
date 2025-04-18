import { Redis } from '@upstash/redis';
import fs from 'fs/promises'; // Import Node.js file system module
import path from 'path'; // Import Node.js path module

// Initialize Redis client with error handling
let redis;
try {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  
  console.log('Redis client initialized successfully');
  // Log partial URL to debug without revealing full credentials
  const partialUrl = process.env.KV_REST_API_URL ? 
    `${process.env.KV_REST_API_URL.substring(0, 15)}...` : 'undefined';
  console.log(`Redis URL (partial): ${partialUrl}`);
} catch (error) {
  console.error('Failed to initialize Redis client:', error);
}

// Path to the products JSON file
const productsFilePath = path.join(process.cwd(), 'data', 'products.json');

// Helper function to read products from Redis - EXPORTED
export const readProducts = async () => {
  if (!redis) {
    console.error('Redis client not initialized');
    throw new Error('Database connection not available');
  }
  try {
    // Use redis.get - Assume client handles parsing
    let products = await redis.get('products');
    
    // If products is null or empty, seed from file
    if (!products) {
      console.log('Redis is empty. Seeding products from products.json (client handles stringify)...');
      try {
        const fileData = await fs.readFile(productsFilePath, 'utf-8');
        const initialProducts = JSON.parse(fileData); // Still need to parse the file data
        
        // Write the initial products to Redis - Assume client handles stringify
        await writeProducts(initialProducts); 
        console.log('Successfully seeded Redis with products (client handles stringify).');
        return initialProducts; // Return the newly seeded data
      } catch (seedError) {
        console.error('Error seeding products from file:', seedError);
        return []; 
      }
    }
    
    // Return the data directly - Assume client handled parsing
    console.log('DEBUG: Returning data directly from redis.get');
    return products;
    
  } catch (error) {
    // Log other errors
    console.error('Error interacting with Redis:', error);
    throw new Error('Failed to fetch products from database');
  }
};

// Helper function to write products to Redis
const writeProducts = async (productsArray) => {
  if (!redis) {
    console.error('Redis client not initialized');
    throw new Error('Database connection not available');
  }
  try {
    // Store products in Redis - Assume client handles stringify
    await redis.set('products', productsArray); 
  } catch (error) {
    console.error('Error writing products to Redis:', error);
    throw new Error('Failed to save product data.');
  }
};

// Helper function to get a product by ID
const getProductById = async (productId) => {
  const products = await readProducts();
  return products.find(product => product.id === productId) || null;
};

// Helper function to filter products by title (case-insensitive search)
const searchProductsByTitle = async (searchTerm) => {
  const products = await readProducts();
  if (!searchTerm) return products;
  
  const searchTermLower = searchTerm.toLowerCase();
  return products.filter(product => 
    product.title && product.title.toLowerCase().includes(searchTermLower)
  );
};

// Helper function to delete products by ID
const deleteProductsByIds = async (idsToDelete) => {
  try {
    const allProducts = await readProducts();
    
    // Filter out products whose IDs are in the deletion list
    const remainingProducts = allProducts.filter(product => 
      !idsToDelete.includes(product.id)
    );
    
    // Write the filtered products back to Redis
    await writeProducts(remainingProducts);
    
    // Return the IDs that were actually found and deleted
    const deletedIds = allProducts
      .filter(product => idsToDelete.includes(product.id))
      .map(product => product.id);
      
    return {
      deletedCount: deletedIds.length,
      deletedIds,
      remainingCount: remainingProducts.length
    };
  } catch (error) {
    console.error('Error deleting products:', error);
    throw new Error('Failed to delete products');
  }
};

// Helper function to validate API key
const validateApiKey = (req) => {
  // Get API key from various sources
  const apiKey = req.headers['x-api-key'] || req.query.api_key || (req.body && req.body.api_key);
  
  // Skip API key validation in development mode or when accessing from same origin
  if (process.env.NODE_ENV === 'development') {
    console.log('Development mode: Skipping API key validation');
    return true;
  }
  
  // Check for API key from same origin (our frontend)
  const referer = req.headers.referer || '';
  const host = req.headers.host || '';
  
  if (referer && referer.includes(host)) {
    console.log('Same origin request detected, allowing access');
    return true;
  }
  
  // Validate API key for external requests
  const expectedApiKey = process.env.API_KEY;
  return apiKey === expectedApiKey;
};

// Main handler function
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Skip validation for GET requests in production for now
  const isValid = req.method === 'GET' || validateApiKey(req);
  
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }

  try {
    if (req.method === 'GET') {
      // Handle GET request with filtering options
      const { id, title } = req.query;
      
      if (id) {
        // Handle GET by ID
        const product = await getProductById(id);
        if (product) {
          res.status(200).json(product);
        } else {
          res.status(404).json({ message: `Product with ID ${id} not found` });
        }
      } else if (title) {
        // Handle GET by title search
        const filteredProducts = await searchProductsByTitle(title);
        res.status(200).json(filteredProducts);
      } else {
        // Default: return all products
        const products = await readProducts();
        res.status(200).json(products);
      }
    } else if (req.method === 'POST') {
      // Handle POST request - add a new product
        
      try {
        // Get request body data - validation
        const { title, imageUrl, description, productUrl } = req.body;
        
        // Check required fields
        if (!title || !productUrl) {
          return res.status(400).json({ 
            message: 'Missing required fields: title and productUrl are required' 
          });
        }
        
        // Create a new product item
        const newProduct = {
          id: Date.now().toString(), // Simple ID generation
          title,
          imageUrl: imageUrl || 'https://upload.wikimedia.org/wikipedia/commons/1/14/No_Image_Available.jpg',
          description: description || '',
          productUrl
        };
        
        // Get existing products array
        const products = await readProducts();
        
        // Add new product
        products.push(newProduct);
        
        // Update Redis
        await writeProducts(products);
        
        // Return success with new product data
        res.status(201).json(newProduct);
      } catch (error) {
        console.error("POST /api/products error:", error);
        res.status(500).json({ message: 'Error adding product', error: error.message });
      }
    } else if (req.method === 'DELETE') {
      // Handle DELETE request - delete products by ID
      try {
        // Get the IDs to delete from request body
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ 
            message: 'Request body must include an "ids" array with at least one product ID'
          });
        }
        
        // Delete the products
        const result = await deleteProductsByIds(ids);
        
        // Return success with deletion results
        res.status(200).json({
          message: `Successfully deleted ${result.deletedCount} products`,
          ...result
        });
      } catch (error) {
        console.error("DELETE /api/products error:", error);
        res.status(500).json({ message: 'Error deleting products', error: error.message });
      }
    } else {
      // Handle unsupported methods
      res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
      res.status(405).end(`Method ${req.method} Not Allowed`);
    }
  } catch (error) {
    console.error("API /api/products error:", error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
} 
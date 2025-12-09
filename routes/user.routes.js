const express = require('express');
const router = express.Router();
const UserController = require('../controllers/user.controller');
const { authMiddleware, adminMiddleware } = require('../middleware/auth.middleware');

router.get('/profile', authMiddleware, UserController.getProfile);
router.put('/profile', authMiddleware, UserController.updateProfile);

// Rutas de Admin para gestión de usuarios
router.get('/', authMiddleware, adminMiddleware, UserController.getAllUsers);
router.get('/:id', authMiddleware, adminMiddleware, UserController.getUserById);
router.post('/', authMiddleware, adminMiddleware, UserController.createUser);
router.put('/:id', authMiddleware, adminMiddleware, UserController.updateUser);
router.delete('/:id', authMiddleware, adminMiddleware, UserController.deleteUser);

module.exports = router;
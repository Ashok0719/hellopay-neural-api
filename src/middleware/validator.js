const { body, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

const otpValidation = [
  body('phone').isLength({ min: 10, max: 10 }).withMessage('Phone must be 10 digits'),
  body('otp').isLength({ min: 4, max: 4 }).withMessage('OTP must be 4 digits'),
  validate,
];

const signupValidation = [
  body('name').if(body('name').exists()).notEmpty().withMessage('Name is required'),
  body('phone').isLength({ min: 10, max: 10 }).withMessage('Phone must be 10 digits'),
  validate,
];

const loginValidation = [
  body('phone').notEmpty().withMessage('Phone number is required'),
  validate,
];

const transferValidation = [
  body('amount').isNumeric().withMessage('Amount must be a number'),
  validate,
];

module.exports = { signupValidation, loginValidation, otpValidation, transferValidation };

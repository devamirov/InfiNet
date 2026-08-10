const express = require('express');
const router = express.Router();
const ToolHistoryDB = require('../db/toolHistory');
const { validateRequiredString, validateNumber } = require('../utils/validation');
const { badRequest, internalError, asyncHandler } = require('../utils/errors');

const isValidEntry = (entry) => {
  return entry &&
    typeof entry.id === 'string' &&
    entry.id.trim().length > 0 &&
    typeof entry.tool === 'string' &&
    entry.tool.trim().length > 0;
};

router.get('/', asyncHandler(async (req, res) => {
  const { userId, userEmail, limit, includeGuests } = req.query;
  
  // Validate limit if provided
  if (limit !== undefined) {
    const limitValidation = validateNumber(limit, 'limit', { min: 1, max: 100, integer: true });
    if (!limitValidation.valid) {
      return res.status(400).json(badRequest(limitValidation.error, 'limit'));
    }
  }

  const history = ToolHistoryDB.getHistory({
    userId: userId || null,
    userEmail: userEmail || null,
    limit: limit ? Number(limit) : undefined,
    includeGuests: includeGuests === 'true'
  });

  res.json({
    history,
    timestamp: new Date().toISOString()
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const entry = req.body;
  
  if (!isValidEntry(entry)) {
    return res.status(400).json(badRequest(
      'Invalid tool history entry. Both "id" and "tool" fields are required and must be non-empty strings.',
      'entry'
    ));
  }

  // Validate id and tool fields
  const idValidation = validateRequiredString(entry.id, 'id', { minLength: 1, maxLength: 255 });
  if (!idValidation.valid) {
    return res.status(400).json(badRequest(idValidation.error, 'id'));
  }

  const toolValidation = validateRequiredString(entry.tool, 'tool', { minLength: 1, maxLength: 100 });
  if (!toolValidation.valid) {
    return res.status(400).json(badRequest(toolValidation.error, 'tool'));
  }

  const timestamp = entry.timestamp || new Date().toISOString();
  ToolHistoryDB.saveEntry({
    ...entry,
    timestamp
  });

  res.status(201).json({
    success: true,
    timestamp
  });
}));

module.exports = router;


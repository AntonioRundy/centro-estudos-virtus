const PROVISIONING_ROLES = Object.freeze(['student', 'teacher', 'admin_teacher', 'secretary']);
const TEACHING_ROLES = new Set(['teacher', 'admin_teacher']);

function isProvisioningRole(role) {
  return PROVISIONING_ROLES.includes(String(role || ''));
}

function canonicalRole(role) {
  return String(role || '') === 'teacher_admin' ? 'admin_teacher' : String(role || '');
}

function isTeachingRole(role) {
  return TEACHING_ROLES.has(canonicalRole(role));
}

module.exports = { PROVISIONING_ROLES, isProvisioningRole, canonicalRole, isTeachingRole };

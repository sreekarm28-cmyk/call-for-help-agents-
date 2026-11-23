const serviceTypes = new Set(['plumber', 'electrician', 'other']);
const timeWindows = new Set(['morning', 'afternoon', 'evening', 'any']);
const bookingPermissions = new Set(['approval', 'automatic']);
const visitDateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata' });

export type ServiceRequestInput = {
  serviceType?: unknown;
  customService?: unknown;
  description?: unknown;
  contactName?: unknown;
  contactPhone?: unknown;
  serviceAddress?: unknown;
  addressStreet?: unknown;
  addressDoor?: unknown;
  addressAreaCity?: unknown;
  addressPinCode?: unknown;
  preferredDate?: unknown;
  preferredTimeWindow?: unknown;
  agentCallTimeWindow?: unknown;
  maxVisitFee?: unknown;
  shareName?: unknown;
  sharePhone?: unknown;
  shareAddress?: unknown;
  bookingPermission?: unknown;
  rememberDetails?: unknown;
};

export type ValidServiceRequest = {
  serviceType: string;
  customService: string | null;
  description: string;
  contactName: string;
  contactPhone: string;
  serviceAddress: string;
  preferredDate: string;
  preferredTimeWindow: string;
  agentCallTimeWindow: string;
  maxVisitFee: number | null;
  shareName: boolean;
  sharePhone: boolean;
  shareAddress: boolean;
  bookingPermission: string;
  rememberDetails: boolean;
};

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function validateServiceRequest(body: ServiceRequestInput): ValidServiceRequest {
  const serviceType = text(body.serviceType);
  const customService = text(body.customService) || null;
  const description = text(body.description);
  const contactName = text(body.contactName);
  const contactPhone = text(body.contactPhone);
  let serviceAddress = text(body.serviceAddress);
  if (body.addressDoor !== undefined || body.addressStreet !== undefined || body.addressAreaCity !== undefined || body.addressPinCode !== undefined) {
    const door = text(body.addressDoor).replace(/\s+/g, ' ');
    const street = text(body.addressStreet).replace(/\s+/g, ' ');
    const areaCity = text(body.addressAreaCity).replace(/\s+/g, ' ');
    const pinCode = text(body.addressPinCode);
    if (body.addressDoor !== undefined && !door) throw new Error('Enter the door, house, or flat details.');
    if (!street || !areaCity) throw new Error('Enter the street address and area and city.');
    if (!/^[1-9]\d{5}$/.test(pinCode)) throw new Error('Enter a valid six-digit PIN code.');
    serviceAddress = door ? [door, street, areaCity, pinCode].join('\n') : [street, areaCity, pinCode].join('\n');
  }
  const preferredDate = text(body.preferredDate);
  const preferredTimeWindow = text(body.preferredTimeWindow);
  const agentCallTimeWindow = text(body.agentCallTimeWindow) || 'any';
  const bookingPermission = text(body.bookingPermission);
  const parsedFee = body.maxVisitFee === null || body.maxVisitFee === ''
    ? null
    : Number(body.maxVisitFee);

  if (!serviceTypes.has(serviceType)) {
    throw new Error('Choose a valid service type.');
  }
  if (serviceType === 'other' && (!customService || customService.length > 100)) {
    throw new Error('Describe the other service you need.');
  }
  if (!description || description.length > 2000) {
    throw new Error('Enter a problem description of up to 2000 characters.');
  }
  if (!contactName || contactName.length > 100) {
    throw new Error('Enter a contact name of up to 100 characters.');
  }
  if (!/^\+?[0-9() .-]{7,25}$/.test(contactPhone) || !/^\d{7,15}$/.test(contactPhone.replace(/\D/g, ''))) {
    throw new Error('Enter a valid contact phone number.');
  }
  if (!serviceAddress || serviceAddress.length > 500) {
    throw new Error('Enter a service address of up to 500 characters.');
  }
  const date = new Date(preferredDate + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate) || !Number.isFinite(date.getTime())
      || date.toISOString().slice(0, 10) !== preferredDate) {
    throw new Error('Choose a valid preferred date.');
  }
  if (preferredDate < visitDateFormat.format(new Date())) {
    throw new Error('Choose today or a future date for the visit.');
  }
  if (!timeWindows.has(preferredTimeWindow) || !timeWindows.has(agentCallTimeWindow)) {
    throw new Error('Choose valid call and visit time windows.');
  }
  if (parsedFee !== null && (!Number.isFinite(parsedFee) || parsedFee < 1 || parsedFee > 1_000_000)) {
    throw new Error('Maximum visit fee must be between 1 and 1,000,000.');
  }
  if (!bookingPermissions.has(bookingPermission)) {
    throw new Error('Choose a valid booking permission.');
  }
  if (bookingPermission === 'automatic' && parsedFee === null) {
    throw new Error('Enter a maximum visit fee for automatic booking.');
  }

  return {
    serviceType,
    customService: serviceType === 'other' ? customService : null,
    description,
    contactName,
    contactPhone,
    serviceAddress,
    preferredDate,
    preferredTimeWindow,
    agentCallTimeWindow,
    maxVisitFee: parsedFee,
    shareName: body.shareName === true,
    sharePhone: body.sharePhone === true,
    shareAddress: body.shareAddress === true,
    bookingPermission,
    rememberDetails: body.rememberDetails === true,
  };
}

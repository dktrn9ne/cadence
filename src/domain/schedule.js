export const TIME_UNITS = {
  seconds15: { label: "15 seconds", seconds: 15 },
  seconds30: { label: "30 seconds", seconds: 30 },
  minute: { label: "1 minute", seconds: 60 },
  minutes5: { label: "5 minutes", seconds: 5 * 60 },
  minutes15: { label: "15 minutes", seconds: 15 * 60 },
  hour: { label: "1 hour", seconds: 60 * 60 },
  day: { label: "1 day", seconds: 24 * 60 * 60 },
  week: { label: "1 week", seconds: 7 * 24 * 60 * 60 },
};

export const FREQUENCIES = ["seconds15", "seconds30", "minute", "minutes5", "minutes15", "hour", "day"];

export const getSchedule = (person) => {
  const payMode = person.payMode || "weekly";
  const hourlyPay = Math.max(0, Number(person.hourlyPay) || 0);
  const hoursPerWeek = Math.max(0, Number(person.hoursPerWeek) || 0);
  const directWeeklyPay = Math.max(0, Number(person.weeklyPay ?? person.amount) || 0);
  const weeklyPay = payMode === "hourly" ? hourlyPay * hoursPerWeek : directWeeklyPay;
  const frequency = TIME_UNITS[person.frequency] || TIME_UNITS.minute;
  const payments = Math.max(1, Math.floor(TIME_UNITS.week.seconds / frequency.seconds));
  const perPayment = weeklyPay / payments;

  return {
    total: weeklyPay,
    payMode,
    hourlyPay,
    hoursPerWeek,
    weeklyPay,
    payments,
    perPayment,
    totalPerPayment: perPayment,
    weeklyEquivalent: weeklyPay,
    frequencyLabel: frequency.label,
    frequencySeconds: frequency.seconds,
  };
};

export const getFrequencyMs = (person) => (TIME_UNITS[person.frequency] || TIME_UNITS.minute).seconds * 1000;

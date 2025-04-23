// --- DOM Elements ---
const loginButton = document.getElementById('login_button');
const signoutButton = document.getElementById('signout_button');
const uploadFormDiv = document.getElementById('upload-form');
const receiptForm = document.getElementById('receiptForm');
const categorySelect = document.getElementById('category');
const receiptAmountInput = document.getElementById('receiptAmount'); // Amount input
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const snapBtn = document.getElementById('snapBtn');
const statusDiv = document.getElementById('status');
const receiptPlaceholder = document.getElementById('receipt-placeholder');
const receiptOptions = document.getElementById('receipt-options');
const galleryBtn = document.getElementById('galleryBtn');
const cameraBtnNew = document.getElementById('cameraBtnNew');
const cancelChoiceBtn = document.getElementById('cancelChoiceBtn');
const cameraView = document.getElementById('camera-view');
const cancelCameraBtn = document.getElementById('cancelCameraBtn');
const receiptPreviewContainer = document.getElementById('receipt-preview-container');
const receiptPreview = document.getElementById('receiptPreview');
const removeReceiptBtn = document.getElementById('removeReceiptBtn');
const receiptImageInputActual = document.getElementById('receiptImageInputActual');

// Main Content and Navigation elements
const mainContent = document.getElementById('main-content');
const bottomNav = document.getElementById('bottom-nav');
const navItems = document.querySelectorAll('.nav-item'); // Get all nav buttons
const contentSections = document.querySelectorAll('.content-section'); // Get all content sections

// Setting Section
const profileInfoDiv = document.getElementById('profile-info');
const userPhoto = document.getElementById('user-photo');
const userName = document.getElementById('user-name');
const userEmail = document.getElementById('user-email');

// --- State Variables ---
let stream = null;
let imageFile = null; // Stores the selected File or captured Blob
let imagePreviewUrl = null; // Store the object URL for cleanup
let currentUser = null; // ADDED: To store user info locally

// --- Helper Function to Update Status Message ---
function updateStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = ''; // Remove existing classes first
    if (type === 'success') { statusDiv.classList.add('status-success'); }
    else if (type === 'error') { statusDiv.classList.add('status-error'); }
    else { statusDiv.classList.add('status-info'); }
    console.log(`SCRIPT: Status Update (${type}): ${message}`); // Keep this log
}

// --- Authentication Flow ---
async function checkLoginStatus() {
    console.log("SCRIPT: checkLoginStatus() called.");
    let finalStatusMessage = 'Please sign in.'; // Default message
    let finalStatusType = 'info';
    let loggedInState = false;

    try {
        // Set initial checking status
        updateStatus('Checking login status...', 'info');

        const response = await fetch('/api/check-auth');
        console.log("SCRIPT: /api/check-auth response status:", response.status);
        if (!response.ok) { throw new Error(`HTTP error ${response.status}`); }

        const data = await response.json();
        console.log("SCRIPT: /api/check-auth response data:", data);

        currentUser = data.loggedIn ? data.user : null;
        loggedInState = data.loggedIn; // Store the logged-in state

        // Determine the final message based on state
        if (loggedInState) {
            finalStatusMessage = 'Ready.'; // Or "Welcome, [Name]!" if currentUser exists
            finalStatusType = 'info'; // Or 'success' if preferred
        } else {
             finalStatusMessage = 'Please sign in.';
             finalStatusType = 'info';
        }

    } catch (error) {
        console.error("SCRIPT: Error checking login status:", error);
        finalStatusMessage = 'Error checking status. Try refreshing.';
        finalStatusType = 'error';
        currentUser = null;
        loggedInState = false; // Ensure logged out on error
    } finally {
        // --- This block runs regardless of try/catch outcome ---
        console.log(`SCRIPT: checkLoginStatus finished. Updating UI with loggedInState = ${loggedInState}`);
        updateUI(loggedInState); // Update the UI based on the determined state

        // --- Set the FINAL status message AFTER UI update ---
        console.log(`SCRIPT: Setting final status message: "${finalStatusMessage}"`);
        updateStatus(finalStatusMessage, finalStatusType);
    }
}
function handleLoginClick() {
    console.log("Redirecting to Google Login...");
    updateStatus('Redirecting to Google Login...', 'info');
    window.location.href = '/auth/google';
}
async function handleSignoutClick() {
    console.log("Signing out...");
    try {
        updateStatus('Signing out...', 'info');
        const response = await fetch('/api/logout', { method: 'POST' });
        const data = await response.json();
        if (response.ok) {
            console.log("Logout successful:", data.message);
            currentUser = null; // Clear stored user data
            updateUI(false);
            updateStatus('Signed out successfully.', 'success');
        } else { throw new Error(data.message || `Server error ${response.status}`); }
    } catch (error) {
        console.error("Logout error:", error); updateStatus(`Logout failed: ${error.message}`, 'error');
    }
}

// --- Function to display user info ---
function displayUserInfo() {
    if (currentUser && profileInfoDiv) {
        console.log("Displaying user info:", currentUser);
        userName.textContent = currentUser.name || 'N/A';
        userEmail.textContent = currentUser.email || 'N/A';
        // Use picture URL or a default/placeholder if missing
        userPhoto.src = currentUser.picture;
        userPhoto.alt = currentUser.name ? `${currentUser.name}'s profile picture` : 'User profile picture';
        profileInfoDiv.style.display = 'flex'; // Show the profile section
    } else if (profileInfoDiv) {
         console.log("No current user data to display or profile div not found.");
         profileInfoDiv.style.display = 'none'; // Hide if no data
    }
}

// --- Navigation Logic ---
function switchSection(targetSectionId) {
    console.log("Switching to section:", targetSectionId);

    // Hide all content sections
    contentSections.forEach(section => {
        section.classList.remove('active-section');
        // section.style.display = 'none'; // Alternative way
    });

    // Deactivate all nav items
    navItems.forEach(item => {
        item.classList.remove('active');
    });

    // Activate the target section and nav item
    const targetSection = document.getElementById(targetSectionId);
    const targetNavItem = document.querySelector(`.nav-item[data-section="${targetSectionId}"]`);

    if (targetSection) {
        targetSection.classList.add('active-section');
        // targetSection.style.display = 'block'; // Alternative way
    } else {
        console.error("Target section not found:", targetSectionId);
    }

    if (targetNavItem) {
        targetNavItem.classList.add('active');
    } else {
        console.error("Target nav item not found for section:", targetSectionId);
    }

    // *** Display user info if switching to settings ***
    if (targetSectionId === 'upload-section') {
        updateStatus('Ready to upload a receipt.', 'info'); // Status specific to this section
        resetReceiptSection(); // Reset upload form when switching to it
    } else if (targetSectionId === 'history-section') {
        updateStatus('Viewing receipt history.', 'info');
    } else if (targetSectionId === 'setting-section') {
        updateStatus('Viewing settings.', 'info');
        displayUserInfo(); // Call display function
    }

   if (targetSectionId !== 'upload-section') { stopCameraStream(); }
}

// --- UI State Management ---
function updateUI(isLoggedIn) {
    console.log(`SCRIPT: updateUI called with isLoggedIn = ${isLoggedIn}`);
    if (isLoggedIn) {
        if(mainContent) mainContent.style.display = 'block';
        if(bottomNav) bottomNav.style.display = 'flex';
        loginButton.style.display = 'none';
        signoutButton.style.display = 'block';
        // Default to the Upload section (switchSection might set its own status later)
        switchSection('upload-section');
        // REMOVED: updateStatus('Ready to upload.', 'info');
    } else {
        if(mainContent) mainContent.style.display = 'none';
        if(bottomNav) bottomNav.style.display = 'none';
        loginButton.style.display = 'block';
        signoutButton.style.display = 'none';
        if(receiptForm) receiptForm.reset();
        resetReceiptSection();
        currentUser = null;
        if(profileInfoDiv) profileInfoDiv.style.display = 'none';
        // REMOVED: updateStatus('Please sign in.', 'info');
    }
}

function showReceiptPlaceholder() {
    receiptPlaceholder.style.display = 'flex'; receiptOptions.style.display = 'none';
    cameraView.style.display = 'none'; receiptPreviewContainer.style.display = 'none';
    stopCameraStream(); updateStatus('Add a receipt image.', 'info');
}
function showReceiptOptions() {
    receiptPlaceholder.style.display = 'none'; receiptOptions.style.display = 'block';
    cameraView.style.display = 'none'; receiptPreviewContainer.style.display = 'none';
    stopCameraStream();
}
function showCameraView() {
    receiptPlaceholder.style.display = 'none'; receiptOptions.style.display = 'none';
    cameraView.style.display = 'block'; receiptPreviewContainer.style.display = 'none';
    startCamera();
}
function showReceiptPreview(imageUrl, source = 'unknown') {
    receiptPlaceholder.style.display = 'none'; receiptOptions.style.display = 'none';
    cameraView.style.display = 'none'; receiptPreview.src = imageUrl;
    receiptPreviewContainer.style.display = 'block'; stopCameraStream();
    console.log(`Showing preview from ${source}`);
}
function resetReceiptSection() {
    imageFile = null; receiptImageInputActual.value = '';
    if (imagePreviewUrl) { URL.revokeObjectURL(imagePreviewUrl); imagePreviewUrl = null; receiptPreview.src = '#'; }
    if (receiptPlaceholder) { showReceiptPlaceholder(); }
    else { console.warn("Receipt placeholder not ready during reset."); }
}

// --- Camera Functionality ---
async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        video.srcObject = stream; console.log("Camera started.");
        updateStatus('Point at receipt and click Snap.', 'info');
    } catch (err) {
        console.error("Error accessing camera:", err);
        updateStatus('Error accessing camera. Try gallery.', 'error'); showReceiptPlaceholder();
    }
}
function snapPhoto() {
    if (!stream || !video.srcObject) { console.error("Camera stream N/A."); return; }
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, canvas.width, canvas.height);
    stopCameraStream();
    canvas.toBlob(blob => {
        if (!blob) { console.error("Blob conversion failed"); updateStatus('Capture failed.', 'error'); resetReceiptSection(); return; }
        blob.name = `receipt_capture_${Date.now()}.jpg`; imageFile = blob;
        console.log("Captured Blob:", imageFile);
        if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl); imagePreviewUrl = URL.createObjectURL(imageFile);
        showReceiptPreview(imagePreviewUrl, 'camera'); updateStatus('Photo captured.', 'info');
    }, 'image/jpeg', 0.9);
}
function stopCameraStream() {
    if (stream) { stream.getTracks().forEach(track => track.stop()); console.log("Camera stopped."); }
    stream = null; if(video) video.srcObject = null;
}

// --- Form Submission ---
async function handleFormSubmit(event) {
    event.preventDefault();
    updateStatus('Processing...', 'info');
    const category = categorySelect.value;
    const userAmount = receiptAmountInput.value; // Get user amount
    const imageBlobOrFile = imageFile;

    // Validation
    if (!category) { updateStatus('Select category.', 'error'); categorySelect.focus(); return; }
    if (!userAmount || isNaN(parseFloat(userAmount)) || parseFloat(userAmount) <= 0) {
        updateStatus('Enter valid positive amount.', 'error'); receiptAmountInput.focus(); return;
    }
    if (!imageBlobOrFile) { updateStatus('Add receipt image.', 'error'); return; }
    // --- End Validation ---

    const amountFormatted = parseFloat(userAmount).toFixed(2);
    console.log(`Uploading. Cat: ${category}, Amt: ${amountFormatted}, Img: ${imageBlobOrFile instanceof File ? 'File' : 'Blob'}`);
    updateStatus('Uploading...', 'info');
    const formData = new FormData();
    formData.append('category', category);
    formData.append('amount', amountFormatted); // Send formatted amount
    const fileName = imageBlobOrFile.name || `receipt_${Date.now()}.jpg`;
    formData.append('receiptImage', imageBlobOrFile, fileName);

    try {
        const response = await fetch('/upload', { method: 'POST', body: formData });
        const result = await response.json();
        if (response.ok) {
            console.log('Upload successful:', result);
            updateStatus(result.message || 'Upload successful!', 'success');
            receiptForm.reset(); // Reset form fields
            resetReceiptSection(); // Reset image section
        } else {
             console.error(`Upload failed: ${response.status}`, result);
             if (response.status === 401) {
                 updateStatus(`Authentication failed: ${result.message || 'Log in again.'}`, 'error'); updateUI(false);
             } else { throw new Error(result.message || `Server error ${response.status}`); }
        }
    } catch (error) {
        console.error('Fetch/upload error:', error); updateStatus(`Upload failed: ${error.message}`, 'error');
    }
}

// --- Event Listeners ---
loginButton.addEventListener('click', handleLoginClick);
signoutButton.addEventListener('click', handleSignoutClick);
receiptForm.addEventListener('submit', handleFormSubmit);
receiptPlaceholder.addEventListener('click', showReceiptOptions);
cancelChoiceBtn.addEventListener('click', showReceiptPlaceholder);
galleryBtn.addEventListener('click', () => { receiptImageInputActual.click(); });
cameraBtnNew.addEventListener('click', showCameraView);
cancelCameraBtn.addEventListener('click', showReceiptPlaceholder);
removeReceiptBtn.addEventListener('click', resetReceiptSection);
snapBtn.addEventListener('click', snapPhoto);
receiptImageInputActual.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
        imageFile = file; console.log("File selected:", imageFile);
        if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl); imagePreviewUrl = URL.createObjectURL(imageFile);
        showReceiptPreview(imagePreviewUrl, 'gallery'); updateStatus('Image selected.', 'info');
    } else { console.log("File selection cancelled."); }
});

// Navigation Item Click Listeners
navItems.forEach(item => {
    item.addEventListener('click', () => {
        const sectionId = item.getAttribute('data-section');
        if (sectionId) {
            switchSection(sectionId);
        }
    });
});

// --- PWA Service Worker Registration ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(reg => { console.log('SW registered: ', reg.scope); })
      .catch(err => { console.error('SW registration failed: ', err); });
  });
} else { console.log('Service workers not supported.'); }

// --- Initial State ---
document.addEventListener('DOMContentLoaded', checkLoginStatus);
updateStatus('Initializing...', 'info');